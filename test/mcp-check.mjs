// Boots index.mjs as a real stdio MCP server and lists its tools — proves the server half
// (handshake + tool registration) without a Claude reload.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const transport = new StdioClientTransport({ command: "node", args: [join(here, "..", "index.mjs")] });
const client = new Client({ name: "check", version: "0" }, { capabilities: {} });
await client.connect(transport);
const { tools } = await client.listTools();
const names = tools.map(t => t.name).sort();
console.log("tools:", names.join(", "));
const want = ["laguna_cancel", "laguna_implement_plan", "laguna_reply", "laguna_status"];
const ok = want.every(w => names.includes(w));
await client.close();
console.log(ok ? "MCP-CHECK PASSED" : "MCP-CHECK FAILED (missing tools)");
process.exit(ok ? 0 : 1);
