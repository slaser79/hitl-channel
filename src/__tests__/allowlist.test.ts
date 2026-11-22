import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hashToken,
  addToAllowlist,
  isTokenAllowed,
  removeFromAllowlist,
  getAllowlistCount,
  loadAllowlist,
} from "../allowlist.js";

describe("allowlist.ts", () => {
  const testToken = "test-device-token-12345";
  const testToken2 = "test-device-token-67890";

  describe("hashToken", () => {
    it("should generate SHA-256 hash", () => {
      const hash = hashToken("test");
      expect(hash).toHaveLength(64); // SHA-256 produces 64 hex chars
    });

    it("should generate consistent hashes", () => {
      const hash1 = hashToken(testToken);
      const hash2 = hashToken(testToken);
      expect(hash1).toBe(hash2);
    });

    it("should generate different hashes for different tokens", () => {
      const hash1 = hashToken(testToken);
      const hash2 = hashToken(testToken2);
      expect(hash1).not.toBe(hash2);
    });
  });

  describe("addToAllowlist", () => {
    it("should add token hash to allowlist", async () => {
      await addToAllowlist(testToken);
      const count = await getAllowlistCount();
      expect(count).toBe(1);
    });

    it("stores only the hash in the configured channel home", async () => {
      await addToAllowlist(testToken);
      const allowlist = await Bun.file(join(process.env.HITL_CHANNEL_HOME!, "allowlist.json")).json();
      const hashes = Object.keys(allowlist.entries);
      expect(hashes.length).toBe(1);
      expect(hashes[0]).toBe(hashToken(testToken));
      // Verify plaintext token is not stored
      expect(allowlist.entries[testToken]).toBeUndefined();
    });

    it("uses ~/.hitl/channels when the channel home is unset", async () => {
      const channelHome = process.env.HITL_CHANNEL_HOME!;
      delete process.env.HITL_CHANNEL_HOME;
      try {
        await addToAllowlist(testToken);
        const file = join(process.env.HOME!, ".hitl", "channels", "allowlist.json");
        expect(await Bun.file(file).exists()).toBe(true);
      } finally {
        process.env.HITL_CHANNEL_HOME = channelHome;
      }
    });

    it("rejects an external allowlist directory and a symlink to it", async () => {
      const outsideHome = await mkdtemp(join(tmpdir(), "hitl-outside-home-"));
      const outsideState = join(outsideHome, ".hitl", "channels");
      const allowlistPath = join(outsideState, "allowlist.json");
      const pairedHash = hashToken("fixture-device");
      const sentinel = JSON.stringify({
        entries: { [pairedHash]: { tokenHash: pairedHash, addedAt: "2026-01-01T00:00:00Z" } },
      });
      const channelHome = process.env.HITL_CHANNEL_HOME!;

      try {
        await mkdir(outsideState, { recursive: true });
        await writeFile(allowlistPath, sentinel);
        process.env.HITL_CHANNEL_HOME = outsideState;
        await expect(addToAllowlist(testToken)).rejects.toThrow("outside the temporary test directory");

        await symlink(outsideState, channelHome, "dir");
        process.env.HITL_CHANNEL_HOME = channelHome;
        await expect(addToAllowlist(testToken)).rejects.toThrow("outside the temporary test directory");
        expect(await readFile(allowlistPath, "utf8")).toBe(sentinel);
      } finally {
        process.env.HITL_CHANNEL_HOME = channelHome;
        await rm(outsideHome, { recursive: true, force: true });
      }
    });
  });

  describe("isTokenAllowed", () => {
    it("starts each test with an empty allowlist", async () => {
      expect(await getAllowlistCount()).toBe(0);
      expect(await isTokenAllowed(testToken)).toBe(false);
    });

    it("should return true for allowlisted token", async () => {
      await addToAllowlist(testToken);
      const allowed = await isTokenAllowed(testToken);
      expect(allowed).toBe(true);
    });

    it("should return false for non-allowlisted token", async () => {
      const allowed = await isTokenAllowed("unknown-token");
      expect(allowed).toBe(false);
    });

    it("should update lastUsed timestamp", async () => {
      await addToAllowlist(testToken);
      await isTokenAllowed(testToken);
      const allowlist = await loadAllowlist();
      const hash = hashToken(testToken);
      expect(allowlist.entries[hash].lastUsed).toBeDefined();
    });
  });

  describe("removeFromAllowlist", () => {
    it("should remove token from allowlist", async () => {
      await addToAllowlist(testToken);
      await removeFromAllowlist(testToken);
      const count = await getAllowlistCount();
      expect(count).toBe(0);
    });

    it("should return false for token not in allowlist", async () => {
      const allowed = await isTokenAllowed("unknown-token");
      expect(allowed).toBe(false);
      // Should not error when removing non-existent token
      await removeFromAllowlist("unknown-token");
    });
  });
});
