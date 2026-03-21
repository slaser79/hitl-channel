import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { sendChannelNotification } from "./notification.js";
import { HitlMessage, HitlWebSocket, ReplyPayload } from "./types.js";
import { createPairingRequest, consumePairingCode, validatePairingCode } from "./pairing.js";
import { addToAllowlist, isTokenAllowed, hashToken } from "./allowlist.js";
import { getIdentity } from "./identity.js";

export const clients = new Set<HitlWebSocket>();

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
  for (const ws of clients) {
    if (ws.readyState === 1) {
      ws.send(rawPayload);
    }
  }
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

            if (!message.trim()) {
              return new Response(
                JSON.stringify({ error: "empty message" }),
                { status: 400, headers: { "content-type": "application/json" } }
              );
            }

            await sendChannelNotification(mcp, message, {
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
        clients.add(ws as unknown as HitlWebSocket);
        process.stderr.write(`[hitl-channel] Client connected (${clients.size} total)\n`);
      },
      close(ws) {
        clients.delete(ws as unknown as HitlWebSocket);
        process.stderr.write(`[hitl-channel] Client disconnected (${clients.size} total)\n`);
      },
      message(_ws, raw) {
        try {
          const data = JSON.parse(String(raw)) as HitlMessage;
          const message = data.message?.trim() || data.content?.trim();
          if (message) {
            sendChannelNotification(mcp, message, {
              sender_id: data.sender_id ?? "unknown",
              ...(data.agent_id ? { agent_id: data.agent_id } : {}),
            }).catch((err) => {
              process.stderr.write(
                `[hitl-channel] Failed to send notification: ${err instanceof Error ? err.message : err}\n`
              );
            });
          }
        } catch {
          // Ignore malformed messages
        }
      },
    },
  });
}
