#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createWebAccessServer } from "../dist-mcp/server.mjs";

// stdout is reserved exclusively for MCP messages.
const server = createWebAccessServer();
let stopping;
function stop() {
	stopping ??= server.close().catch((error) => {
		process.stderr.write(`Web access shutdown failed: ${error.message}\n`);
		process.exitCode = 1;
	}).finally(() => process.stdin.pause());
	return stopping;
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.stdin.once("end", stop);
try {
	await server.connect(new StdioServerTransport());
} catch (error) {
	process.stderr.write(`Web access startup failed: ${error.message}\n`);
	process.exitCode = 1;
	await stop();
}
