/**
 * mDNS service advertisement.
 * 
 * - Advertises _hitl-channel._tcp service on local network
 * - Uses bonjour-service package
 * - Allows mobile app to discover channel instances
 */

import type { Bonjour, Service } from "bonjour-service";
import type { InstanceCapabilities } from "./types.js";

let bonjour: Bonjour | null = null;
let advertisedService: Service | null = null;

export interface MdnsMeta {
  mode?: string;
  harness?: string;
  capabilities?: Partial<InstanceCapabilities>;
}

/**
 * Start advertising the hitl-channel service via mDNS.
 */
export function startMDNS(
  port: number,
  instanceId?: string,
  displayName?: string,
  meta?: MdnsMeta,
): void {
  try {
    // Dynamically import bonjour-service
    const { Bonjour } = require("bonjour-service") as { Bonjour: new () => Bonjour };
    bonjour = new Bonjour();

    // Always include instanceId suffix for uniqueness — displayName is in TXT records
    const baseName = displayName || "hitl-channel";
    const serviceName = instanceId
      ? `${baseName}-${instanceId.slice(0, 8)}`
      : baseName;

    const txt: Record<string, string> = {
      version: "0.0.1",
      instanceId: instanceId || "unknown",
      displayName: displayName || "",
    };
    if (meta?.mode) {
      txt.mode = meta.mode;
    }
    if (meta?.harness) {
      txt.harness = meta.harness;
    }
    if (meta?.capabilities) {
      const caps: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(meta.capabilities)) {
        if (typeof v === "boolean") {
          caps[k] = v;
        }
      }
      txt.capabilities = JSON.stringify(caps);
    }

    advertisedService = bonjour.publish({
      name: serviceName,
      type: "hitl-channel",
      protocol: "tcp",
      port,
      txt,
    });
    
    process.stderr.write(`[hitl-channel] mDNS advertising started: ${serviceName} on port ${port}\n`);
  } catch (error) {
    process.stderr.write(`[hitl-channel] Failed to start mDNS: ${error}\n`);
  }
}

/**
 * Stop advertising the mDNS service.
 */
export function stopMDNS(): void {
  if (advertisedService) {
    try {
      advertisedService.stop?.();
      advertisedService = null;
      process.stderr.write("[hitl-channel] mDNS advertising stopped\n");
    } catch (error) {
      process.stderr.write(`[hitl-channel] Failed to stop mDNS: ${error}\n`);
    }
  }

  if (bonjour) {
    try {
      bonjour.destroy();
      bonjour = null;
    } catch (error) {
      process.stderr.write(`[hitl-channel] Failed to destroy bonjour: ${error}\n`);
    }
  }
}

/**
 * Check if mDNS is currently advertising.
 */
export function isMDNSAdvertising(): boolean {
  return advertisedService !== null && bonjour !== null;
}
