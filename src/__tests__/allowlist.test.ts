import { describe, expect, it, beforeEach, afterEach } from "bun:test";
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

  beforeEach(async () => {
    // Clear allowlist before each test
    const allowlist = await loadAllowlist();
    allowlist.entries = {};
    const file = Bun.file("~/.hitl/channels/allowlist.json");
    await Bun.write(file, JSON.stringify(allowlist, null, 2));
  });

  afterEach(async () => {
    // Cleanup
  });

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

    it("should store hash, not plaintext", async () => {
      await addToAllowlist(testToken);
      const allowlist = await loadAllowlist();
      const hashes = Object.keys(allowlist.entries);
      expect(hashes.length).toBe(1);
      expect(hashes[0]).toBe(hashToken(testToken));
      // Verify plaintext token is not stored
      expect(allowlist.entries[testToken]).toBeUndefined();
    });
  });

  describe("isTokenAllowed", () => {
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
