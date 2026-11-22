import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function getChannelHome(): string {
  const override = process.env.HITL_CHANNEL_HOME?.trim();
  if (override) return resolve(override);

  const home = process.env.HOME?.trim() || homedir();
  return resolve(home, ".hitl", "channels");
}

// Resolve existing ancestors too, so a symlink cannot redirect a new file
// from the test directory into the user's home.
function resolveExistingAncestors(path: string): string {
  try {
    return realpathSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`Channel test state path contains a dangling symlink: ${path}`);
    }
    const parent = dirname(path);
    if (parent === path) throw err;
    return join(resolveExistingAncestors(parent), relative(parent, path));
  }
}

export function assertTestStatePath(path: string): void {
  const root = process.env.HITL_CHANNEL_TEST_ROOT;
  if (!root) return;

  const target = relative(root, resolveExistingAncestors(resolve(path)));
  if (target === ".." || target.startsWith(`..${sep}`) || isAbsolute(target)) {
    throw new Error(`Channel test state path is outside the temporary test directory: ${path}`);
  }
}
