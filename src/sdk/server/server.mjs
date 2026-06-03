#!/usr/bin/env node
import { parseLaunchArgs, StreamJsonServer } from "./protocol.mjs";
import { resolveProvider } from "./providers/index.mjs";
import { Session } from "./session.mjs";

let options;
try {
  options = parseLaunchArgs(process.argv.slice(2), { agent: process.env.LITE_HARNESS_DEFAULT_AGENT || "claude" });
} catch (e) {
  process.stderr.write(`${e.message}\n`);
  process.exit(2);
}

let provider;
try {
  provider = await resolveProvider(options.agent);
} catch (e) {
  process.stderr.write(`${e.message}\n`);
  process.exit(2);
}

const session = new Session({
  provider,
  model: options.model,
  permissionMode: options.permissionMode,
  cwd: options.cwd,
  env: process.env,
  stderr: process.stderr,
});
new StreamJsonServer({ session }).start();
