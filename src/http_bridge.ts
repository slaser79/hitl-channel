import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { sendChannelNotification } from "./notification.js";
import { HitlAttachment, HitlMessage, HitlWebSocket, ReplyPayload } from "./types.js";
import { createPairingRequest, consumePairingCode, validatePairingCode } from "./pairing.js";
import { addToAllowlist, isTokenAllowed, hashToken } from "./allowlist.js";
import { getIdentity } from "./identity.js";
import { FrameCorrelator } from "./correlator.js";
import { appendAudit, appendBufferDrainAudit, sha256Hex, type BufferDrainAuditLine } from "./audit.js";
import { ReplyBuffer } from "./reply_buffer.js";

export const clients = new Set<HitlWebSocket>();

// SPEC-HITL-CC-001 §4.2 — single correlator instance shared with server.ts so
// inbound `tool_call_result` / `list_tools_result` frames can resolve waiters.
export const correlator = new FrameCorrelator();

// SPEC-HITL-CC-001 Phase 4 AC#26 — per-instance ReplyBuffer. Replies that
// arrive while no WS clients are connected get queued here and drained on the
// next WS reconnect (see `drainBufferToClient` + the WS `open` handler).
export const replyBuffer = new ReplyBuffer();

function wsSendAccepted(ws: HitlWebSocket, data: string): boolean {
  try {
    const result = ws.send(data);
    return typeof result !== "number" || result > 0;
  } catch {
    return false;
  }
}

/**
 * Broadcast a JSON frame to every connected phone WS. Used by `call_phone_tool`
 * / `list_phone_tools` to push a request frame. Returns the number of clients
 * the frame was actually delivered to.
 */
export function broadcastFrame(frame: Record<string, unknown>): number {
  const raw = JSON.stringify(frame);
  let count = 0;
  for (const ws of clients) {
    if (ws.readyState === 1 && wsSendAccepted(ws, raw)) {
      count++;
    }
  }
  return count;
}

/**
 * Generate a new device token (UUID).
 */
function generateDeviceToken(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Check authentication using either:
 * - Legacy API key (for backward compatibility during transition)
 * - Device token from allowlist (new auth method)
 */
async function isAuthenticated(req: Request): Promise<{ valid: boolean; reason?: string }> {
  const authHeader = req.headers.get("authorization");
  const url = new URL(req.url);
  const urlToken = url.searchParams.get("token");
  const urlApiKey = url.searchParams.get("api_key");
  
  // Extract Bearer token
  let token: string | undefined;
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  } else if (urlToken) {
    token = urlToken;
  } else if (urlApiKey) {
    // Legacy API key support (for backward compatibility)
    const apiKey = process.env.HITL_CHANNEL_API_KEY ?? "";
    if (urlApiKey === apiKey) {
      return { valid: true };
    }
  }
  
  if (!token) {
    return { valid: false, reason: "missing_token" };
  }
  
  // Check if token is in allowlist
  if (await isTokenAllowed(token)) {
    return { valid: true };
  }
  
  // Fallback to legacy API key
  const apiKey = process.env.HITL_CHANNEL_API_KEY ?? "";
  if (apiKey && token === apiKey) {
    return { valid: true };
  }
  
  return { valid: false, reason: "invalid_token" };
}

export function broadcastReply(text: string, messageId?: string, agentId?: string): void {
  const payload: ReplyPayload = {
    type: "reply",
    text,
    content: text,
    id: `r${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    message_id: messageId,
    agent_id: agentId,
    ts: new Date().toISOString(),
  };
  const rawPayload = JSON.stringify(payload);
  let sent = 0;
  for (const ws of clients) {
    if (ws.readyState === 1 && wsSendAccepted(ws, rawPayload)) {
      sent++;
    }
  }
  // SPEC-HITL-CC-001 Phase 4 AC#26 — instead of silently dropping when no
  // OPEN WS client received the frame, queue for replay on next WS reconnect.
  if (sent === 0) {
    replyBuffer.push(payload);
  }
}

/**
 * SPEC-HITL-CC-001 Phase 4 AC#26 — synchronously send buffered replies to
 * `ws` in arrival order, removing each entry from `buffer` ONLY AFTER
 * `ws.send` succeeds (peek + per-entry commit). If `ws.readyState`
 * transitions out of OPEN mid-loop, remaining entries stay in the buffer
 * for replay on the next reconnect.
 *
 * This function is intentionally synchronous (no awaits) so that callers
 * invoking it from a Bun WS `open` handler are guaranteed all sends finish
 * before any subsequent `broadcastReply` call can race on the new client —
 * Bun runs handlers single-threaded and cannot interleave between
 * `clients.add(ws)` and this loop's completion.
 *
 * Returns `{sent, oldestQueuedAt}`. `oldestQueuedAt` is null when `sent === 0`.
 */
export function drainBufferToClientSync(
  ws: HitlWebSocket,
  buffer: ReplyBuffer = replyBuffer,
): { sent: number; oldestQueuedAt: number | null } {
  const peeked = buffer.peek();
  if (peeked.length === 0) return { sent: 0, oldestQueuedAt: null };
  // sequence-sort puts the earliest-pushed entry first, but under clock
  // rollback that entry's queuedAt is NOT necessarily the minimum — scan
  // the whole peek to find the true oldest wall-clock value for audit.
  let oldestQueuedAt = peeked[0]!.queuedAt;
  for (const e of peeked) {
    if (e.queuedAt < oldestQueuedAt) oldestQueuedAt = e.queuedAt;
  }
  let sent = 0;
  for (const entry of peeked) {
    if (ws.readyState !== 1) break;
    // entry.raw is the JSON.stringify(payload) cached at push time —
    // re-using it avoids re-serializing on every reconnect.
    if (!wsSendAccepted(ws, entry.raw)) break;
    buffer.commit(entry);
    sent++;
  }
  return { sent, oldestQueuedAt: sent > 0 ? oldestQueuedAt : null };
}

/**
 * Async wrapper around drainBufferToClientSync that also emits the
 * `phone_offline_buffer_drain` audit line. The `audit` parameter is
 * injected for test isolation. Returns the number of entries actually sent
 * to `ws` (matches the value of `replies_drained` in the emitted audit line).
 */
export async function drainBufferToClient(
  ws: HitlWebSocket,
  buffer: ReplyBuffer = replyBuffer,
  audit: (line: BufferDrainAuditLine) => Promise<void> = appendBufferDrainAudit,
  nowMs: () => number = () => Date.now(),
): Promise<number> {
  const { sent, oldestQueuedAt } = drainBufferToClientSync(ws, buffer);
  if (sent === 0 || oldestQueuedAt === null) return 0;
  const oldestSeconds = Math.max(0, Math.floor((nowMs() - oldestQueuedAt) / 1000));
  await audit({
    ts: new Date().toISOString(),
    instance_id: process.env.HITL_INSTANCE_ID ?? "unknown",
    event: "phone_offline_buffer_drain",
    replies_drained: sent,
    oldest_buffered_seconds: oldestSeconds,
  });
  return sent;
}

/**
 * Save image attachments to the inbox directory and return updated content
 * with file paths appended.
 */
async function processAttachments(
  message: string,
  attachments?: HitlAttachment[]
): Promise<string> {
  if (!attachments || attachments.length === 0) return message;

  const inboxDir = `${process.env.HOME}/.claude/channels/hitl-channel/inbox`;
  await Bun.$`mkdir -p ${inboxDir}`.quiet();

  let contentForNotification = message;

  for (const attachment of attachments) {
    if (attachment.type === "image" && attachment.data) {
      const ext = attachment.media_type?.split("/")[1] || "jpg";
      const fileName =
        attachment.fileName || `img_${Date.now()}.${ext}`;
      const filePath = `${inboxDir}/${fileName}`;

      const buffer = Buffer.from(attachment.data, "base64");
      await Bun.write(filePath, buffer);

      contentForNotification += `\n\n[Image: ${filePath}]`;
      process.stderr.write(
        `[hitl-channel] Saved image: ${filePath} (${buffer.length} bytes)\n`
      );
    }
  }

  return contentForNotification;
}

export function startHttpBridge(mcp: Server) {
  const apiKey = process.env.HITL_CHANNEL_API_KEY ?? "";
  const port = Number(process.env.HITL_CHANNEL_PORT ?? 8789);

  process.stderr.write(`[hitl-channel] Starting HTTP bridge on http://0.0.0.0:${port}\n`);
  return Bun.serve({
    port: port,
    hostname: "0.0.0.0",
    async fetch(req, server) {
      const url = new URL(req.url);

      // Health endpoint (no auth required)
      if (url.pathname === "/health") {
        return new Response(
          JSON.stringify({ status: "ok", port: port, clients: clients.size }),
          { headers: { "content-type": "application/json" } }
        );
      }

      // Instance identity endpoint (no auth required)
      if (url.pathname === "/instance") {
        return (async () => {
          const identity = await getIdentity();
          return new Response(
            JSON.stringify({
              instanceId: identity.instanceId,
              hostname: identity.hostname,
              displayName: identity.displayName,
            }),
            { headers: { "content-type": "application/json" } }
          );
        })();
      }

      // Pairing request endpoint - POST /pair/request
      if (url.pathname === "/pair/request" && req.method === "POST") {
        return (async () => {
          const code = createPairingRequest();
          process.stderr.write(`\n[hitl-channel] PAIRING CODE: ${code}\n`);
          process.stderr.write(`[hitl-channel] Code expires in 5 minutes\n\n`);

          // Push pairing code into Claude Code via channel notification
          await sendChannelNotification(mcp,
            `🔑 Pairing request received. Code: ${code} (expires in 5 minutes). Please relay this code to the user.`,
            { sender_id: "hitl-channel", type: "pairing_request" }
          );

          // Return 202 Accepted (code NOT in response body)
          return new Response(
            JSON.stringify({
              status: "pending",
              message: "Pairing code sent to Claude Code session",
              expires_in: 300, // 5 minutes in seconds
            }),
            {
              status: 202,
              headers: { "content-type": "application/json" }
            }
          );
        })();
      }

      // Pairing validate endpoint - POST /pair/validate
      if (url.pathname === "/pair/validate" && req.method === "POST") {
        return (async () => {
          try {
            const body = (await req.json()) as { code?: string } | null;
            const code = body?.code;
            
            if (!code || typeof code !== "string" || !/^\d{6}$/.test(code)) {
              return new Response(
                JSON.stringify({ error: "invalid code format (must be 6 digits)" }),
                { status: 400, headers: { "content-type": "application/json" } }
              );
            }
            
            if (!validatePairingCode(code)) {
              return new Response(
                JSON.stringify({ error: "invalid or expired code" }),
                { status: 403, headers: { "content-type": "application/json" } }
              );
            }
            
            // Consume the code and generate device token
            consumePairingCode(code);
            const deviceToken = generateDeviceToken();
            
            // Add token to allowlist (stored as hash)
            await addToAllowlist(deviceToken);
            
            return new Response(
              JSON.stringify({ 
                status: "paired",
                device_token: deviceToken,
                message: "Device successfully paired",
              }),
              { 
                status: 200,
                headers: { "content-type": "application/json" }
              }
            );
          } catch (err) {
            return new Response(
              JSON.stringify({
                error: err instanceof Error ? err.message : "invalid request body",
              }),
              { status: 400, headers: { "content-type": "application/json" } }
            );
          }
        })();
      }

      // Auth check for protected endpoints
      const authResult = await isAuthenticated(req);
      if (!authResult.valid) {
        return new Response(
          JSON.stringify({ error: "unauthorized", reason: authResult.reason }),
          { status: 401, headers: { "content-type": "application/json" } }
        );
      }

      // WebSocket upgrade
      if (url.pathname === "/ws") {
        if (server.upgrade(req)) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // Main message endpoint - POST /
      if (req.method === "POST" && url.pathname === "/") {
        return (async () => {
          try {
            const body = (await req.json()) as HitlMessage | null;
            if (!body || typeof body !== "object") {
              return new Response(
                JSON.stringify({ error: "invalid JSON body" }),
                { status: 400, headers: { "content-type": "application/json" } }
              );
            }
            const message = String(body.message ?? body.content ?? "");
            const senderId = String(body.sender_id ?? "unknown");
            const agentId = body.agent_id ? String(body.agent_id) : undefined;
            const attachments = body.attachments;

            if (!message.trim() && (!attachments || attachments.length === 0)) {
              return new Response(
                JSON.stringify({ error: "empty message" }),
                { status: 400, headers: { "content-type": "application/json" } }
              );
            }

            const contentForNotification = await processAttachments(
              message,
              attachments
            );

            await sendChannelNotification(mcp, contentForNotification, {
              sender_id: senderId,
              ...(agentId ? { agent_id: agentId } : {}),
            });

            return new Response(JSON.stringify({ status: "delivered" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          } catch (err) {
            return new Response(
              JSON.stringify({
                error: err instanceof Error ? err.message : "unknown error",
              }),
              { status: 500, headers: { "content-type": "application/json" } }
            );
          }
        })();
      }

      return new Response("Not Found", { status: 404 });
    },
    websocket: {
      open(ws) {
        const typedWs = ws as unknown as HitlWebSocket;
        clients.add(typedWs);
        process.stderr.write(`[hitl-channel] Client connected (${clients.size} total)\n`);
        // SPEC-HITL-CC-001 Phase 4 AC#26 — replay queued replies to this
        // client. drainBufferToClient invokes drainBufferToClientSync first
        // (no awaits before the ws.send loop), so all sends complete before
        // the async wrapper yields to await the audit emit. Bun runs WS
        // handlers single-threaded, so no broadcastReply can interleave
        // between `clients.add(ws)` above and the sync send loop. Peek+commit
        // makes the drain idempotent against concurrent reconnects (a second
        // client's open handler peeks an empty buffer and returns zero), so
        // the previous `clients.size === 1` guard is unnecessary and would
        // wrongly skip the drain when a stale client lingers in `clients`.
        void drainBufferToClient(typedWs).catch((err) => {
          process.stderr.write(
            `[hitl-channel] buffer drain failed: ${err instanceof Error ? err.message : err}\n`
          );
        });
      },
      close(ws) {
        clients.delete(ws as unknown as HitlWebSocket);
        process.stderr.write(`[hitl-channel] Client disconnected (${clients.size} total)\n`);
      },
      message(_ws, raw) {
        try {
          const data = JSON.parse(String(raw)) as Record<string, unknown> & HitlMessage;
          // SPEC-HITL-CC-001 §4.2 — `type`-first routing: control frames must
          // never fall through to the chat-notification path. A
          // `tool_call_result` arriving for an unknown / already-resolved
          // request_id is logged at warn level and dropped (no waiter, no
          // audit double-count) per the idempotency contract.
          const frameType = typeof data.type === "string" ? data.type : undefined;
          if (frameType === "tool_call_result" || frameType === "list_tools_result") {
            const reqId = typeof data.request_id === "string" ? data.request_id : undefined;
            if (!reqId) {
              process.stderr.write(
                `[hitl-channel] WARN ${frameType} missing request_id — dropped\n`
              );
              return;
            }
            const resolved = correlator.resolve(reqId, data);
            if (!resolved) {
              process.stderr.write(
                `[hitl-channel] WARN ${frameType} for unknown request_id ${reqId} — dropped\n`
              );
              return;
            }
            // Async audit; don't block WS path.
            void appendAudit({
              ts: new Date().toISOString(),
              instance_id: process.env.HITL_INSTANCE_ID ?? "unknown",
              direction: "phone_returns_to_cc",
              kind: "tool_result",
              tool_name:
                frameType === "tool_call_result"
                  ? (typeof data.tool_name === "string" ? data.tool_name : null)
                  : null,
              approval:
                frameType === "tool_call_result"
                  ? ((data.approval as "auto" | "user_approved" | "user_denied" | "timeout" | undefined) ?? null)
                  : null,
              prompt_hash: sha256Hex(JSON.stringify(data)),
              duration_ms: null,
            });
            return;
          }

          const message = data.message?.trim() || data.content?.trim();
          if (message || (data.attachments && data.attachments.length > 0)) {
            processAttachments(message ?? "", data.attachments)
              .then((content) =>
                sendChannelNotification(mcp, content, {
                  sender_id: data.sender_id ?? "unknown",
                  ...(data.agent_id ? { agent_id: data.agent_id } : {}),
                })
              )
              .catch((err) => {
                process.stderr.write(
                  `[hitl-channel] Failed to send notification: ${err instanceof Error ? err.message : err}\n`
                );
              });
            void appendAudit({
              ts: new Date().toISOString(),
              instance_id: process.env.HITL_INSTANCE_ID ?? "unknown",
              direction: "phone_to_cc",
              kind: "message",
              tool_name: null,
              approval: null,
              prompt_hash: sha256Hex(message ?? ""),
              duration_ms: null,
            });
          }
        } catch {
          // Ignore malformed messages
        }
      },
    },
  });
}
