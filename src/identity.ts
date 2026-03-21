/**
 * Instance identity management.
 *
 * - Stored at ~/.hitl/channels/identity.json
 * - Instance ID is a random UUID (stable across restarts)
 * - Used for multi-instance support
 */

import { $ } from "bun";

const IDENTITY_DIR = "~/.hitl/channels";
const IDENTITY_FILE = `${IDENTITY_DIR}/identity.json`;

export interface InstanceIdentity {
  instanceId: string;
  hostname: string;
  createdAt: string;
}

/**
 * Ensure the identity directory exists.
 */
async function ensureDir(): Promise<void> {
  try {
    await $`mkdir -p ${IDENTITY_DIR}`.quiet();
  } catch (error) {
    process.stderr.write(`[hitl-channel] Failed to create directory: ${error}\n`);
  }
}

/**
 * Load the instance identity from disk.
 * Creates a new identity if it doesn't exist.
 */
export async function loadIdentity(): Promise<InstanceIdentity> {
  try {
    const file = Bun.file(IDENTITY_FILE);
    if (await file.exists()) {
      const content = await file.text();
      return JSON.parse(content) as InstanceIdentity;
    }
  } catch (error) {
    process.stderr.write(`[hitl-channel] Failed to load identity: ${error}\n`);
  }

  // Create new identity
  const identity = await createIdentity();
  await saveIdentity(identity);
  return identity;
}

/**
 * Create a new instance identity.
 */
async function createIdentity(): Promise<InstanceIdentity> {
  const hostname = await getHostname();
  const identity: InstanceIdentity = {
    instanceId: crypto.randomUUID(),
    hostname,
    createdAt: new Date().toISOString(),
  };
  process.stderr.write(`[hitl-channel] Created new instance identity: ${identity.instanceId}\n`);
  return identity;
}

/**
 * Save the instance identity to disk.
 */
async function saveIdentity(identity: InstanceIdentity): Promise<void> {
  await ensureDir();
  const file = Bun.file(IDENTITY_FILE);
  await Bun.write(file, JSON.stringify(identity, null, 2));
}

/**
 * Get the current instance identity.
 */
export async function getIdentity(): Promise<InstanceIdentity> {
  return loadIdentity();
}

/**
 * Get the hostname (for identity purposes).
 */
async function getHostname(): Promise<string> {
  try {
    // Try to read from /etc/hostname first
    const hostnameFile = Bun.file("/etc/hostname");
    if (await hostnameFile.exists()) {
      return (await hostnameFile.text()).trim();
    }

    // Fallback to environment
    return process.env.HOSTNAME || "unknown";
  } catch {
    return process.env.HOSTNAME || "unknown";
  }
}
