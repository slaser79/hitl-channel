import { afterAll, beforeEach } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testRoot = realpathSync(mkdtempSync(join(tmpdir(), "hitl-channel-tests-")));
process.env.HITL_CHANNEL_TEST_ROOT = testRoot;

function isolateHome(): void {
  const home = mkdtempSync(join(testRoot, "home-"));
  process.env.HOME = home;
  process.env.HITL_CHANNEL_HOME = join(home, "channel-state");
  delete process.env.HITL_CHANNEL_IDENTITY_FILE;
}

// Isolate imports and beforeAll hooks as well as individual tests.
isolateHome();
beforeEach(isolateHome);

// Some audit writes are fire-and-forget. Keep their directories through the suite.
afterAll(() => rmSync(testRoot, { recursive: true, force: true }));
