#!/usr/bin/env bun
export {};

const args = process.argv.slice(2);
const subcommand = args[0];

if (subcommand === "daemon") {
  const { runDaemonCli } = await import("./daemon.js");
  await runDaemonCli(args.slice(1));
} else if (subcommand === "mcp-shim") {
  process.stderr.write(
    "[hitl-channel] mcp-shim is planned for Phase 2 (non-HTTP ACP harnesses).\n",
  );
  process.exit(1);
} else {
  await import("./server.js");
}
