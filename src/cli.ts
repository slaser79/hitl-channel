#!/usr/bin/env bun
export {};

const args = process.argv.slice(2);
const subcommand = args[0];

if (subcommand === "daemon") {
  const { runDaemonCli } = await import("./daemon.js");
  await runDaemonCli(args.slice(1));
} else if (subcommand === "mcp-shim") {
  const { runMcpShimCli } = await import("./mcp_shim.js");
  await runMcpShimCli(args.slice(1));
} else {
  await import("./server.js");
}
