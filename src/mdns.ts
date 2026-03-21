/**
 * mDNS service advertisement.
 * 
 * - Advertises _hitl-channel._tcp service on local network
 * - Uses bonjour-service package
 * - Allows mobile app to discover channel instances
 */

import type { Bonjour, Service } from "bonjour-service";

let bonjour: Bonjour | null = null;
let advertisedService: Service | null = null;

/**
 * Start advertising the hitl-channel service via mDNS.
 */
export function startMDNS(port: number, instanceId?: string, displayName?: string): void {
  try {
    // Dynamically import bonjour-service
    const { Bonjour } = require("bonjour-service") as { Bonjour: new () => Bonjour };
    bonjour = new Bonjour();

    // Always include instanceId suffix for uniqueness — displayName is in TXT records
    const baseName = displayName || "hitl-channel";
    const serviceName = instanceId
      ? `${baseName}-${instanceId.slice(0, 8)}`
      : baseName;

    advertisedService = bonjour.publish({
      name: serviceName,
      type: "_hitl-channel._tcp",
      port,
      txt: {
        version: "0.0.1",
        instanceId: instanceId || "unknown",
        displayName: displayName || "",
      },
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
