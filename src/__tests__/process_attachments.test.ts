/**
 * Issue #36 — phone→CC file attachments must persist for type:"file" as well
 * as type:"image", with path-traversal-safe names and accurate WS audit rows.
 *
 * AV1–AV5 from the issue Agent Verification criteria.
 */
import {
  describe,
  expect,
  it,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  processAttachments,
  sanitizeAttachmentFileName,
  startHttpBridge,
} from "../http_bridge.js";

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

describe("sanitizeAttachmentFileName", () => {
  it("returns fallback for empty / missing names", () => {
    expect(sanitizeAttachmentFileName(undefined, "fb.bin")).toBe("fb.bin");
    expect(sanitizeAttachmentFileName("", "fb.bin")).toBe("fb.bin");
  });

  it("strips path traversal and absolute prefixes to basename only", () => {
    expect(sanitizeAttachmentFileName("../../evil.sh", "fb.bin")).toBe(
      "evil.sh",
    );
    expect(sanitizeAttachmentFileName("/etc/passwd", "fb.bin")).toBe("passwd");
    expect(sanitizeAttachmentFileName("a/b/c.json", "fb.bin")).toBe("c.json");
    expect(sanitizeAttachmentFileName("..\\..\\evil.bat", "fb.bin")).toBe(
      "evil.bat",
    );
  });

  it("strips leading dots so names cannot hide or reintroduce ..", () => {
    expect(sanitizeAttachmentFileName("..", "fb.bin")).toBe("fb.bin");
    expect(sanitizeAttachmentFileName(".", "fb.bin")).toBe("fb.bin");
    expect(sanitizeAttachmentFileName("...hidden", "fb.bin")).toBe("hidden");
  });
});

describe("processAttachments (unit — AV1–AV4)", () => {
  let homeDir: string;
  let inboxDir: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "hitl-att-"));
    prevHome = process.env.HOME;
    process.env.HOME = homeDir;
    inboxDir = join(homeDir, ".claude", "channels", "hitl-channel", "inbox");
  });

  afterEach(async () => {
    process.env.HOME = prevHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  it("AV1: type:file (application/json) writes decoded bytes and [File: path] marker", async () => {
    const jsonBody = '{"hello":"world"}';
    const content = await processAttachments("Please analyze the attached file.", [
      {
        type: "file",
        media_type: "application/json",
        data: b64(jsonBody),
        fileName: "payload.json",
      },
    ]);

    const expectedPath = join(inboxDir, "payload.json");
    expect(content).toContain("[File: " + expectedPath + "]");
    expect(content).toContain("Please analyze the attached file.");
    const onDisk = await readFile(expectedPath, "utf8");
    expect(onDisk).toBe(jsonBody);
  });

  it("AV2: type:image still produces [Image: path] with identical bytes (regression)", async () => {
    // Minimal 1x1 PNG
    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const content = await processAttachments("see image", [
      {
        type: "image",
        media_type: "image/png",
        data: pngBytes.toString("base64"),
        fileName: "dot.png",
      },
    ]);

    const expectedPath = join(inboxDir, "dot.png");
    expect(content).toContain("[Image: " + expectedPath + "]");
    expect(content).not.toContain("[File:");
    const onDisk = await readFile(expectedPath);
    expect(Buffer.compare(onDisk, pngBytes)).toBe(0);
  });

  it("AV3: traversal-hostile fileName is confined to the inbox dir", async () => {
    const body = "#!/bin/sh\necho pwned\n";
    for (const hostile of [
      "../../evil.sh",
      "/tmp/absolute.sh",
      "nested/../escape.sh",
      "a/b/c/deep.txt",
    ]) {
      const content = await processAttachments("msg", [
        {
          type: "file",
          media_type: "application/x-sh",
          data: b64(body),
          fileName: hostile,
        },
      ]);
      const match = content.match(/\[File: ([^\]]+)\]/);
      expect(match).not.toBeNull();
      const writtenPath = match![1]!;
      expect(writtenPath.startsWith(inboxDir + "/")).toBe(true);
      expect(writtenPath.includes("..")).toBe(false);
      // Only basename should remain under inbox.
      const base = writtenPath.slice(inboxDir.length + 1);
      expect(base.includes("/")).toBe(false);
      const onDisk = await readFile(writtenPath, "utf8");
      expect(onDisk).toBe(body);
    }
  });

  it("AV4: attachment without data is skipped with stderr warning; message still delivered", async () => {
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return (origWrite as (c: string | Uint8Array, ...a: unknown[]) => boolean)(
        chunk,
        ...args,
      );
    }) as typeof process.stderr.write;

    try {
      const content = await processAttachments("text only survives", [
        {
          type: "file",
          media_type: "application/json",
          data: "", // empty → treated as missing
          fileName: "empty.json",
        } as { type: string; media_type: string; data: string; fileName: string },
        {
          type: "file",
          media_type: "application/json",
          // data omitted
          fileName: "nodata.json",
        } as { type: string; media_type: string; data: string; fileName: string },
      ]);

      expect(content).toBe("text only survives");
      expect(content).not.toContain("[File:");
      const warning = stderrChunks.join("");
      expect(warning).toMatch(/Skipping attachment \(missing data\)/);

      // Inbox may exist but should not contain the skipped names as payloads
      // (mkdir happens up front if there are attachments).
      try {
        const files = await readdir(inboxDir);
        expect(files).not.toContain("empty.json");
        expect(files).not.toContain("nodata.json");
      } catch {
        // inbox may not exist if we short-circuit — also fine
      }
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it("persists non-image types other than file (e.g. application/pdf as type:document)", async () => {
    const pdfMagic = "%PDF-1.4 fake";
    const content = await processAttachments("pdf please", [
      {
        type: "document",
        media_type: "application/pdf",
        data: b64(pdfMagic),
        fileName: "report.pdf",
      },
    ]);
    const expectedPath = join(inboxDir, "report.pdf");
    expect(content).toContain("[File: " + expectedPath + "]");
    expect(await readFile(expectedPath, "utf8")).toBe(pdfMagic);
  });
});

describe("POST / + WS chat attachments (integration AV1 + AV5)", () => {
  const TEST_PORT = 8796;
  const TEST_API_KEY = "test-key-attachments-36";
  let server: ReturnType<typeof startHttpBridge>;
  let lastNotification: { params?: { content?: string } } | null = null;
  let homeDir: string;
  let prevHome: string | undefined;
  let prevPort: string | undefined;
  let prevKey: string | undefined;
  let prevInstance: string | undefined;

  beforeAll(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "hitl-att-http-"));
    prevHome = process.env.HOME;
    prevPort = process.env.HITL_CHANNEL_PORT;
    prevKey = process.env.HITL_CHANNEL_API_KEY;
    prevInstance = process.env.HITL_INSTANCE_ID;
    process.env.HOME = homeDir;
    process.env.HITL_CHANNEL_PORT = String(TEST_PORT);
    process.env.HITL_CHANNEL_API_KEY = TEST_API_KEY;
    process.env.HITL_INSTANCE_ID = "instance-att-36";

    const mcpMock = {
      notification: async (notif: unknown) => {
        lastNotification = notif as { params?: { content?: string } };
      },
    } as unknown as Server;
    server = startHttpBridge(mcpMock);
  });

  afterAll(async () => {
    server.stop(true);
    process.env.HOME = prevHome;
    process.env.HITL_CHANNEL_PORT = prevPort;
    process.env.HITL_CHANNEL_API_KEY = prevKey;
    process.env.HITL_INSTANCE_ID = prevInstance;
    await rm(homeDir, { recursive: true, force: true });
  });

  it("AV1 via POST /: file attachment lands in inbox and notification content has [File:]", async () => {
    lastNotification = null;
    const jsonBody = '{"from":"post"}';
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: "Please analyze the attached file.",
        attachments: [
          {
            type: "file",
            media_type: "application/json",
            data: b64(jsonBody),
            fileName: "from_post.json",
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    // notification is awaited inside the POST handler before response
    expect(lastNotification).not.toBeNull();
    const content = lastNotification!.params!.content!;
    expect(content).toContain("[File:");
    expect(content).toContain("from_post.json");
    const inboxPath = join(
      homeDir,
      ".claude",
      "channels",
      "hitl-channel",
      "inbox",
      "from_post.json",
    );
    expect(await readFile(inboxPath, "utf8")).toBe(jsonBody);
  });

  it("AV5: WS chat-branch audit row carries real attachment_count/bytes", async () => {
    // audit.ts captures AUDIT_DIR via os.homedir() at module load — not
    // process.env.HOME from this suite. Match our row by instance_id.
    const auditFile = join(
      homedir(),
      ".hitl",
      "channels",
      "audit",
      `${new Date().toISOString().slice(0, 10)}.jsonl`,
    );
    const instanceId = "instance-att-36";
    const marker = `av5-ws-${Date.now()}`;

    const raw = "ws-payload-bytes!!";
    const dataB64 = b64(raw);
    const expectedBytes = Buffer.byteLength(dataB64, "base64");

    const ws = new WebSocket(
      `ws://127.0.0.1:${TEST_PORT}/ws?api_key=${TEST_API_KEY}`,
    );
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
    });

    try {
      ws.send(
        JSON.stringify({
          message: marker,
          attachments: [
            {
              type: "file",
              media_type: "text/plain",
              data: dataB64,
              fileName: "ws.txt",
            },
          ],
        }),
      );

      // Audit is fire-and-forget; poll briefly for our instance_id row.
      let row: {
        attachment_count?: number;
        attachment_bytes?: number;
        direction?: string;
        kind?: string;
        instance_id?: string;
        prompt_hash?: string;
      } | null = null;
      const { sha256Hex } = await import("../audit.js");
      const expectedHash = sha256Hex(marker);

      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 25));
        try {
          const text = await readFile(auditFile, "utf8");
          const lines = text
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as NonNullable<typeof row>);
          const hit = lines.find(
            (l) =>
              l.instance_id === instanceId &&
              l.direction === "phone_to_cc" &&
              l.kind === "message" &&
              l.prompt_hash === expectedHash,
          );
          if (hit) {
            row = hit;
            break;
          }
        } catch {
          // file not ready yet
        }
      }

      expect(row).not.toBeNull();
      expect(row!.attachment_count).toBe(1);
      expect(row!.attachment_bytes).toBe(expectedBytes);
    } finally {
      ws.close();
    }
  });
});
