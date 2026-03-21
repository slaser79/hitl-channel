import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { 
  generatePairingCode, 
  createPairingRequest, 
  validatePairingCode, 
  consumePairingCode,
  cleanupExpiredPairings,
  getPendingPairingCount,
} from "../pairing.js";

describe("pairing.ts", () => {
  beforeEach(() => {
    // Clear all pending pairings before each test
    // We can't directly clear the map, so we rely on tests being isolated
  });

  afterEach(() => {
    // Cleanup after tests
  });

  describe("generatePairingCode", () => {
    it("should generate a 6-digit numeric code", () => {
      const code = generatePairingCode();
      expect(code).toMatch(/^\d{6}$/);
    });

    it("should generate different codes each time", () => {
      const codes = new Set();
      for (let i = 0; i < 100; i++) {
        codes.add(generatePairingCode());
      }
      // All codes should be unique (or at least very high probability)
      expect(codes.size).toBeGreaterThan(90);
    });

    it("should generate codes in range 100000-999999", () => {
      for (let i = 0; i < 100; i++) {
        const code = generatePairingCode();
        const num = parseInt(code, 10);
        expect(num).toBeGreaterThanOrEqual(100000);
        expect(num).toBeLessThanOrEqual(999999);
      }
    });
  });

  describe("createPairingRequest", () => {
    it("should create a pending pairing and return the code", () => {
      const code = createPairingRequest();
      expect(code).toMatch(/^\d{6}$/);
      expect(validatePairingCode(code)).toBe(true);
    });

    it("should increment pending pairing count", () => {
      const before = getPendingPairingCount();
      createPairingRequest();
      const after = getPendingPairingCount();
      expect(after).toBeGreaterThan(before);
    });
  });

  describe("validatePairingCode", () => {
    it("should return true for valid code", () => {
      const code = createPairingRequest();
      expect(validatePairingCode(code)).toBe(true);
    });

    it("should return false for non-existent code", () => {
      expect(validatePairingCode("123456")).toBe(false);
    });

    it("should return false for malformed code", () => {
      expect(validatePairingCode("abc123")).toBe(false);
      expect(validatePairingCode("12345")).toBe(false);
      expect(validatePairingCode("1234567")).toBe(false);
    });
  });

  describe("consumePairingCode", () => {
    it("should consume a valid code and return true", () => {
      const code = createPairingRequest();
      expect(consumePairingCode(code)).toBe(true);
      // After consumption, validation should fail
      expect(validatePairingCode(code)).toBe(false);
    });

    it("should return false for already consumed code", () => {
      const code = createPairingRequest();
      consumePairingCode(code);
      expect(consumePairingCode(code)).toBe(false);
    });

    it("should return false for non-existent code", () => {
      expect(consumePairingCode("999999")).toBe(false);
    });
  });

  describe("cleanupExpiredPairings", () => {
    it("should not remove valid pairings", () => {
      const code = createPairingRequest();
      cleanupExpiredPairings();
      expect(validatePairingCode(code)).toBe(true);
    });

    it("should decrement count after consuming code", () => {
      const code = createPairingRequest();
      const before = getPendingPairingCount();
      consumePairingCode(code);
      const after = getPendingPairingCount();
      expect(after).toBeLessThan(before);
    });
  });
});
