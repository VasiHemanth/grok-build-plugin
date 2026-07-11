import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, "../plugins/grok/scripts/grok-mcp.mjs");

// Send a batch of JSON-RPC requests to the MCP server over stdio and collect
// the line-delimited responses. Resolves once we've seen a reply per request
// that carries an id. Does NOT call tools/call, so no Grok account is needed.
function rpc(requests, { timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "inherit"] });
    const expected = requests.filter((r) => r.id !== undefined).length;
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("MCP server timed out"));
    }, timeout);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const lines = out.split("\n").filter((l) => l.trim());
      if (lines.length >= expected) {
        clearTimeout(timer);
        child.kill();
        resolve(lines.map((l) => JSON.parse(l)));
      }
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });

    for (const r of requests) {
      child.stdin.write(`${JSON.stringify(r)}\n`);
    }
  });
}

test("MCP server initializes with serverInfo grok", async () => {
  const res = await rpc([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } }
  ]);
  const init = res.find((r) => r.id === 1);
  assert.equal(init.result.serverInfo.name, "grok");
  assert.ok(init.result.capabilities.tools, "advertises tools capability");
});

test("MCP server lists the grok_search tool with a query schema", async () => {
  const res = await rpc([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } },
    { jsonrpc: "2.0", id: 2, method: "tools/list" }
  ]);
  const list = res.find((r) => r.id === 2);
  const tool = list.result.tools.find((t) => t.name === "grok_search");
  assert.ok(tool, "grok_search is listed");
  assert.equal(tool.inputSchema.required[0], "query");
});

test("MCP server returns a JSON-RPC error for unknown methods", async () => {
  const res = await rpc([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "no/such/method" }
  ]);
  const err = res.find((r) => r.id === 2);
  assert.equal(err.error.code, -32601);
});

test("MCP server advertises no tools when recursion guard is set", async () => {
  const childEnv = { ...process.env, GROK_SEARCH_MCP_RECURSION_GUARD: "1" };
  const res = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      stdio: ["pipe", "pipe", "inherit"],
      env: childEnv
    });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("timeout"));
    }, 5000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const lines = out.split("\n").filter((l) => l.trim());
      if (lines.length >= 2) {
        clearTimeout(timer);
        child.kill();
        resolve(lines.map((l) => JSON.parse(l)));
      }
    });
    child.on("error", reject);
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } })}\n`
    );
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  });
  const list = res.find((r) => r.id === 2);
  assert.deepEqual(list.result.tools, []);
});
