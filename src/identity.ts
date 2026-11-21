/**
 * Instance identity management.
 *
 * - Default path: ~/.hitl/channels/identity.json (overridable via HITL_CHANNEL_IDENTITY_FILE)
 * - Instance ID is a random UUID (stable across restarts)
 * - Used for multi-instance support
 */

import { mkdir } from "node:fs/promises";
import { homedir, hostname as osHostname } from "node:os";
import { dirname } from "node:path";

export function getIdentityFilePath(): string {
  const override = process.env.HITL_CHANNEL_IDENTITY_FILE?.trim();
  if (override) {
    return override;
  }
  const home = process.env.HOME?.trim() || homedir();
  return `${home}/.hitl/channels/identity.json`;
}

export interface InstanceIdentity {
  instanceId: string;
  hostname: string;
  displayName: string;
  createdAt: string;
}

/**
 * Ensure the identity directory exists.
 */
async function ensureDir(filePath: string): Promise<void> {
  try {
    await mkdir(dirname(filePath), { recursive: true });
  } catch (error) {
    process.stderr.write(`[hitl-channel] Failed to create directory: ${error}\n`);
  }
}

/**
 * Load the instance identity from disk.
 * Creates a new identity if it doesn't exist.
 */
export async function loadIdentity(): Promise<InstanceIdentity> {
  const filePath = getIdentityFilePath();
  try {
    const file = Bun.file(filePath);
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
  const displayName = process.env.HITL_CHANNEL_NAME || hostname;
  const identity: InstanceIdentity = {
    instanceId: crypto.randomUUID(),
    hostname,
    displayName,
    createdAt: new Date().toISOString(),
  };
  process.stderr.write(`[hitl-channel] Created new instance identity: ${identity.instanceId}\n`);
  return identity;
}

/**
 * Save the instance identity to disk.
 */
async function saveIdentity(identity: InstanceIdentity): Promise<void> {
  const filePath = getIdentityFilePath();
  await ensureDir(filePath);
  const file = Bun.file(filePath);
  await Bun.write(file, JSON.stringify(identity, null, 2));
}

/**
 * Get the current instance identity.
 */
export async function getIdentity(): Promise<InstanceIdentity> {
  const identity = await loadIdentity();
  // Always prefer HITL_CHANNEL_NAME env var over stored displayName
  const envName = process.env.HITL_CHANNEL_NAME;
  if (envName && envName !== identity.displayName) {
    identity.displayName = envName;
    await saveIdentity(identity);
  }
  return identity;
}

/**
 * Get the hostname (for identity purposes).
 */
export async function getHostname(): Promise<string> {
  try {
    // Try to read from /etc/hostname first
    const hostnameFile = Bun.file("/etc/hostname");
    if (await hostnameFile.exists()) {
      const fileHost = (await hostnameFile.text()).trim();
      if (fileHost) return fileHost;
    }
  } catch {
    // Fall through to env / os.hostname()
  }

  const envHost = process.env.HOSTNAME?.trim();
  if (envHost) return envHost;

  try {
    const sysHost = osHostname().trim();
    if (sysHost) return sysHost;
  } catch {
    // Fall through
  }

  return "unknown";
}
