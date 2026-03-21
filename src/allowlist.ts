/**
 * Sender allowlist management.
 *
 * - Stored at ~/.hitl/channels/allowlist.json
 * - Device tokens stored as SHA-256 hashes (not plaintext)
 * - Persistent across restarts
 */

import { $ } from "bun";

const ALLOWLIST_DIR = "~/.hitl/channels";
const ALLOWLIST_FILE = `${ALLOWLIST_DIR}/allowlist.json`;

export interface AllowlistEntry {
  tokenHash: string;
  addedAt: string;
  lastUsed?: string;
}

export interface AllowlistData {
  entries: Record<string, AllowlistEntry>;
}

/**
 * Ensure the allowlist directory exists.
 */
async function ensureDir(): Promise<void> {
  try {
    await $`mkdir -p ${ALLOWLIST_DIR}`.quiet();
  } catch (error) {
    process.stderr.write(`[hitl-channel] Failed to create directory: ${error}\n`);
  }
}

/**
 * Load the allowlist from disk.
 * Returns empty allowlist if file doesn't exist.
 */
export async function loadAllowlist(): Promise<AllowlistData> {
  try {
    const file = Bun.file(ALLOWLIST_FILE);
    if (!(await file.exists())) {
      return { entries: {} };
    }
    const content = await file.text();
    return JSON.parse(content) as AllowlistData;
  } catch (error) {
    process.stderr.write(`[hitl-channel] Failed to load allowlist: ${error}\n`);
    return { entries: {} };
  }
}

/**
 * Save the allowlist to disk.
 */
async function saveAllowlist(data: AllowlistData): Promise<void> {
  await ensureDir();
  const file = Bun.file(ALLOWLIST_FILE);
  await Bun.write(file, JSON.stringify(data, null, 2));
}

/**
 * Hash a token using SHA-256.
 */
export function hashToken(token: string): string {
  // Use Bun's SHA256 utility
  const hash = Bun.SHA256.hash(new TextEncoder().encode(token));
  return Array.from(new Uint8Array(hash.buffer as ArrayBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Add a device token to the allowlist.
 * Stores the hash, not the plaintext token.
 */
export async function addToAllowlist(token: string): Promise<void> {
  const allowlist = await loadAllowlist();
  const tokenHash = hashToken(token);
  
  allowlist.entries[tokenHash] = {
    tokenHash,
    addedAt: new Date().toISOString(),
  };
  
  await saveAllowlist(allowlist);
  process.stderr.write(`[hitl-channel] Added device to allowlist (hash: ${tokenHash.slice(0, 8)}...)\n`);
}

/**
 * Check if a token is in the allowlist.
 * Updates lastUsed timestamp if found.
 */
export async function isTokenAllowed(token: string): Promise<boolean> {
  const allowlist = await loadAllowlist();
  const tokenHash = hashToken(token);
  
  if (allowlist.entries[tokenHash]) {
    allowlist.entries[tokenHash].lastUsed = new Date().toISOString();
    await saveAllowlist(allowlist);
    return true;
  }
  
  return false;
}

/**
 * Remove a token from the allowlist.
 */
export async function removeFromAllowlist(token: string): Promise<void> {
  const allowlist = await loadAllowlist();
  const tokenHash = hashToken(token);
  
  if (allowlist.entries[tokenHash]) {
    delete allowlist.entries[tokenHash];
    await saveAllowlist(allowlist);
    process.stderr.write(`[hitl-channel] Removed device from allowlist\n`);
  }
}

/**
 * Get all allowlisted entries (for admin/debugging).
 * Returns hashes only, never plaintext tokens.
 */
export async function getAllowlistEntries(): Promise<AllowlistEntry[]> {
  const allowlist = await loadAllowlist();
  return Object.values(allowlist.entries);
}

/**
 * Get the number of allowlisted devices (for testing).
 */
export async function getAllowlistCount(): Promise<number> {
  const allowlist = await loadAllowlist();
  return Object.keys(allowlist.entries).length;
}
