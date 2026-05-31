import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "gen-mcp-config.mjs");

function runScript(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code) reject(new Error(`gen-mcp-config exited ${code}: ${stderr}`));
      else resolve(JSON.parse(stdout || "{}"));
    });
  });
}

function withMcpServerList(handler) {
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/mcp/server") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        servers: [
          { alias: "lap-slack" },
          { alias: "linear" },
          { server_name: "support_slack_bot" },
        ],
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", async () => {
      const { port } = server.address();
      try {
        resolve(await handler(`http://127.0.0.1:${port}`));
      } catch (e) {
        reject(e);
      } finally {
        server.close();
      }
    });
  });
}

test("gateway Slack MCP servers are excluded by default", async () => {
  await withMcpServerList(async (base) => {
    const config = await runScript({
      LITELLM_API_BASE: base,
      LITELLM_API_KEY: "sk-test",
    });

    assert.ok(config.linear);
    assert.equal(config["lap-slack"], undefined);
    assert.equal(config.support_slack_bot, undefined);
  });
});

test("gateway Slack MCP servers can be explicitly re-enabled", async () => {
  await withMcpServerList(async (base) => {
    const config = await runScript({
      LITELLM_API_BASE: base,
      LITELLM_API_KEY: "sk-test",
      LAP_ENABLE_GATEWAY_SLACK_MCP: "1",
    });

    assert.ok(config.linear);
    assert.ok(config["lap-slack"]);
    assert.ok(config.support_slack_bot);
  });
});
