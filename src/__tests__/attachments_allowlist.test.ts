import { describe, expect, it, afterEach } from "bun:test";
import { resolveAttachments, attachmentRoots, isPathAllowed, kMaxFileReadBytes } from "../server.js";
import { writeFileSync, unlinkSync, mkdirSync, symlinkSync, rmSync, existsSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";

describe("Attachments Allowlist and Warnings", () => {
  const originalEnv = process.env.HITL_CHANNEL_ATTACHMENT_ROOTS;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.HITL_CHANNEL_ATTACHMENT_ROOTS = originalEnv;
    } else {
      delete process.env.HITL_CHANNEL_ATTACHMENT_ROOTS;
    }
  });

  it("AV1: resolveAttachments with a file under /tmp returns one entry with data", async () => {
    const filePath = "/tmp/hitl-test-av1.txt";
    writeFileSync(filePath, "hello world av1", "utf8");
    try {
      const { attachments, warnings } = await resolveAttachments([{ path: filePath }]);
      expect(warnings.length).toBe(0);
      expect(attachments.length).toBe(1);
      expect(attachments[0].type).toBe("file");
      expect(attachments[0].media_type).toBe("text/plain");
      expect(Buffer.from(attachments[0].data, "base64").toString("utf8")).toBe("hello world av1");
    } finally {
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
    }
  });

  it("AV2: realpath/symlink normalisation allows symlinked paths", async () => {
    // Create a target directory and a symlink to it
    const targetDir = "/tmp/hitl-sym-target";
    const symlinkDir = "/tmp/hitl-sym-link";
    
    if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
    if (existsSync(symlinkDir)) unlinkSync(symlinkDir);

    mkdirSync(targetDir);
    symlinkSync(targetDir, symlinkDir);

    const testFile = join(targetDir, "test.txt");
    writeFileSync(testFile, "hello symlink", "utf8");

    // Let's set the allowlist roots to include the symlink directory
    process.env.HITL_CHANNEL_ATTACHMENT_ROOTS = symlinkDir;

    try {
      // 1. Resolve path using the symlinked path prefix
      const pathViaSymlink = join(symlinkDir, "test.txt");
      const res1 = await resolveAttachments([{ path: pathViaSymlink }]);
      expect(res1.warnings.length).toBe(0);
      expect(res1.attachments.length).toBe(1);

      // 2. Resolve path using the real/target path prefix
      const pathViaReal = join(targetDir, "test.txt");
      const res2 = await resolveAttachments([{ path: pathViaReal }]);
      expect(res2.warnings.length).toBe(0);
      expect(res2.attachments.length).toBe(1);
    } finally {
      if (existsSync(testFile)) unlinkSync(testFile);
      if (existsSync(symlinkDir)) unlinkSync(symlinkDir);
      if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it("AV2.1: symlink inside allowlisted root pointing outside must be rejected (Security)", async () => {
    const testWorkdir = join(tmpdir(), "hitl-security-test-" + Date.now());
    if (existsSync(testWorkdir)) rmSync(testWorkdir, { recursive: true, force: true });
    mkdirSync(testWorkdir);

    const allowlistedDir = join(testWorkdir, "allowlisted");
    mkdirSync(allowlistedDir);

    const sensitiveFile = join(testWorkdir, "sensitive.txt");
    writeFileSync(sensitiveFile, "SECRET_TOKEN=12345", "utf8");

    const evilSymlink = join(allowlistedDir, "evil.txt");
    symlinkSync(sensitiveFile, evilSymlink);

    process.env.HITL_CHANNEL_ATTACHMENT_ROOTS = allowlistedDir;

    try {
      const { attachments, warnings } = await resolveAttachments([{ path: evilSymlink }]);
      expect(attachments.length).toBe(0);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("path outside allowlist");
    } finally {
      if (existsSync(testWorkdir)) rmSync(testWorkdir, { recursive: true, force: true });
    }
  });

  it("AV3: rejected path (outside allowlist / missing / oversized) produces warnings", async () => {
    // 1. Outside allowlist
    process.env.HITL_CHANNEL_ATTACHMENT_ROOTS = "/tmp/some-strict-dir";
    const outsidePath = "/tmp/hitl-outside-test.txt";
    writeFileSync(outsidePath, "outside content", "utf8");
    try {
      const res1 = await resolveAttachments([{ path: outsidePath }]);
      expect(res1.attachments.length).toBe(0);
      expect(res1.warnings.length).toBe(1);
      expect(res1.warnings[0]).toContain("path outside allowlist");
    } finally {
      if (existsSync(outsidePath)) unlinkSync(outsidePath);
    }

    // Restore env for next tests
    delete process.env.HITL_CHANNEL_ATTACHMENT_ROOTS;

    // 2. Missing file
    const missingPath = "/tmp/hitl-nonexistent-file.txt";
    const res2 = await resolveAttachments([{ path: missingPath }]);
    expect(res2.attachments.length).toBe(0);
    expect(res2.warnings.length).toBe(1);
    expect(res2.warnings[0]).toContain("failed to resolve path");

    // 3. Oversized file (write 5MB + 1 byte file)
    const oversizedPath = "/tmp/hitl-oversized.txt";
    const oversizedSize = kMaxFileReadBytes + 1;
    const buf = Buffer.alloc(oversizedSize);
    writeFileSync(oversizedPath, buf);
    try {
      const res3 = await resolveAttachments([{ path: oversizedPath }]);
      expect(res3.attachments.length).toBe(0);
      expect(res3.warnings.length).toBe(1);
      expect(res3.warnings[0]).toContain("file size exceeds limit");
    } finally {
      if (existsSync(oversizedPath)) unlinkSync(oversizedPath);
    }
  });

  it("AV4: HITL_CHANNEL_ATTACHMENT_ROOTS override constrains allowed roots", () => {
    process.env.HITL_CHANNEL_ATTACHMENT_ROOTS = "/tmp/only-here";
    const roots = attachmentRoots();
    
    // Should contain resolved /tmp/only-here
    expect(roots).toContain(resolvePath("/tmp/only-here"));
    
    // Should NOT contain tmpdir() or homedir()
    expect(roots).not.toContain(resolvePath(tmpdir()));
  });
});
