#!/usr/bin/env node
import { UnifiedAgentSDK } from "./unified-sdk.mjs";
import { parseLaunchArgs, StreamJsonServer } from "./protocol.mjs";

let options;
try {
  options = parseLaunchArgs(process.argv.slice(2), {
    agent: process.env.LITE_HARNESS_DEFAULT_AGENT || "claude",
  });
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
}

const sdk = new UnifiedAgentSDK({
  agent: options.agent,
  model: options.model,
  permissionMode: options.permissionMode,
  cwd: options.cwd,
  env: process.env,
  stderr: process.stderr,
});

new StreamJsonServer({ sdk }).start();
