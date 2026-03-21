/**
 * Pairing code generation and validation.
 * 
 * - 6-digit numeric codes
 * - 5-minute expiry
 * - In-memory storage (ephemeral)
 */

interface PendingPairing {
  code: string;
  createdAt: number;
  expiresAt: number;
}

const CODE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

const pendingPairings = new Map<string, PendingPairing>();

/**
 * Generate a random 6-digit pairing code.
 */
export function generatePairingCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Create a new pending pairing request.
 * Returns the generated code.
 */
export function createPairingRequest(): string {
  const code = generatePairingCode();
  const now = Date.now();
  
  pendingPairings.set(code, {
    code,
    createdAt: now,
    expiresAt: now + CODE_EXPIRY_MS,
  });
  
  return code;
}

/**
 * Validate a pairing code.
 * Returns true if the code is valid and not expired.
 */
export function validatePairingCode(code: string): boolean {
  const pairing = pendingPairings.get(code);
  if (!pairing) return false;
  
  if (Date.now() > pairing.expiresAt) {
    pendingPairings.delete(code);
    return false;
  }
  
  return true;
}

/**
 * Consume a pairing code (remove after successful validation).
 * Returns true if the code was valid and consumed.
 */
export function consumePairingCode(code: string): boolean {
  if (!validatePairingCode(code)) return false;
  pendingPairings.delete(code);
  return true;
}

/**
 * Clean up expired pairing codes.
 * Called periodically to prevent memory leaks.
 */
export function cleanupExpiredPairings(): void {
  const now = Date.now();
  for (const [code, pairing] of pendingPairings.entries()) {
    if (now > pairing.expiresAt) {
      pendingPairings.delete(code);
    }
  }
}

/**
 * Get the number of pending pairing requests (for testing).
 */
export function getPendingPairingCount(): number {
  cleanupExpiredPairings();
  return pendingPairings.size;
}
