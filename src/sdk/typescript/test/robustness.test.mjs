// Robustness tests for the hardening changes:
//   1. a single malformed stdout line does NOT tear down the turn,
//   2. normal completion ends stdin gracefully (server exits on its own),
//   3. abort rejects an in-flight / pending control promise (no hang),
//   4. a partial `env` option is merged onto process.env (PATH survives).
//
// These drive query() against small inline fake servers passed via the
// LITE_HARNESS_SERVER env resolution. Runs against compiled ../dist.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { query } from "../dist/index.js";
import { AbortError } from "../dist/errors.js";

const here = dirname(fileURLToPath(import.meta.url));

function writeServer(name, body) {
  const dir = mkdtempSync(join(tmpdir(), "lh-sdk-"));
  const path = join(dir, name);
  writeFileSync(path, body, "utf8");
  return path;
}

test("a malformed stdout line does not kill the turn", async () => {
  // Server emits: system init, a garbage non-JSON line, an assistant line,
  // then a result. The garbage line must be skipped, not fatal.
  const server = writeServer(
    "malformed-server.mjs",
    `
import { createInterface } from "node:readline";
function send(o){ process.stdout.write(JSON.stringify(o)+"\\n"); }
const rl = createInterface({ input: process.stdin });
rl.on("line",(line)=>{
  const t=line.trim(); if(!t) return;
  let m; try{ m=JSON.parse(t);}catch{return;}
  if(m.type==="control_request"){
    send({type:"control_response",response:{request_id:m.request_id,subtype:"success"}});
    return;
  }
  if(m.type==="user"){
    setImmediate(()=>{
      send({type:"system",subtype:"init",session_id:"s1",model:"fake"});
      process.stdout.write("this is not json at all\\n"); // malformed line
      send({type:"assistant",message:{model:"fake",content:[{type:"text",text:"ok"}]},parent_tool_use_id:null});
      send({type:"result",subtype:"success",session_id:"s1",duration_ms:1,duration_api_ms:1,is_error:false,num_turns:1,total_cost_usd:0,usage:{},result:"ok"});
    });
  }
});
rl.on("close",()=>process.exit(0));
`,
  );

  const diagnostics = [];
  const q = query({
    prompt: "hi",
    options: {
      env: { LITE_HARNESS_SERVER: `node ${server}` },
      stderr: (line) => diagnostics.push(line),
    },
  });

  const types = [];
  for await (const msg of q) {
    types.push(msg.type);
  }

  // The turn completed normally despite the garbage line in the middle.
  assert.deepEqual(types, ["system", "assistant", "result"]);
  // The skipped line was surfaced as a diagnostic, not a fatal error.
  assert.ok(
    diagnostics.some((d) => d.includes("skipped unparseable stdout line")),
    "expected a skipped-line diagnostic on the stderr callback",
  );
});

test("normal completion ends stdin so the server exits on its own", async () => {
  // The server records WHY it stops: a graceful shutdown ends stdin, which
  // fires readline 'close'. If we had hard-killed it instead, it would have
  // died by signal before writing its goodbye line. We assert it saw stdin EOF.
  const sentinelDir = mkdtempSync(join(tmpdir(), "lh-sentinel-"));
  const sentinel = join(sentinelDir, "exit-reason.txt");
  const server = writeServer(
    "graceful-server.mjs",
    `
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
function send(o){ process.stdout.write(JSON.stringify(o)+"\\n"); }
const rl = createInterface({ input: process.stdin });
rl.on("line",(line)=>{
  const t=line.trim(); if(!t) return;
  let m; try{ m=JSON.parse(t);}catch{return;}
  if(m.type==="control_request"){
    send({type:"control_response",response:{request_id:m.request_id,subtype:"success"}});
    return;
  }
  if(m.type==="user"){
    setImmediate(()=>{
      send({type:"system",subtype:"init",session_id:"s1",model:"fake"});
      send({type:"result",subtype:"success",session_id:"s1",duration_ms:1,duration_api_ms:1,is_error:false,num_turns:1,total_cost_usd:0,usage:{},result:"done"});
    });
  }
});
rl.on("close",()=>{ writeFileSync(${JSON.stringify(sentinel)}, "stdin-eof"); process.exit(0); });
`,
  );

  const q = query({
    prompt: "hi",
    options: { env: { LITE_HARNESS_SERVER: `node ${server}` } },
  });
  for await (const _msg of q) {
    // drain to completion (graceful shutdown path)
  }

  // The graceful path ended stdin; the server observed EOF and recorded it.
  const { readFileSync } = await import("node:fs");
  const reason = readFileSync(sentinel, "utf8");
  assert.equal(reason, "stdin-eof");
});

test("abort rejects a pending control promise instead of hanging", async () => {
  // This server ACKs initialize but NEVER replies to interrupt, so the
  // interrupt promise would hang forever if abort didn't reject pending
  // control requests.
  const server = writeServer(
    "no-interrupt-ack-server.mjs",
    `
import { createInterface } from "node:readline";
function send(o){ process.stdout.write(JSON.stringify(o)+"\\n"); }
const rl = createInterface({ input: process.stdin });
rl.on("line",(line)=>{
  const t=line.trim(); if(!t) return;
  let m; try{ m=JSON.parse(t);}catch{return;}
  if(m.type==="control_request"){
    if(m.request && m.request.subtype==="interrupt"){ return; } // never ack
    send({type:"control_response",response:{request_id:m.request_id,subtype:"success"}});
    return;
  }
  if(m.type==="user"){
    setImmediate(()=>{
      send({type:"system",subtype:"init",session_id:"s1",model:"fake"});
      // No result — keep the turn open.
    });
  }
});
rl.on("close",()=>process.exit(0));
`,
  );

  const ac = new AbortController();
  const q = query({
    prompt: "hi",
    options: {
      env: { LITE_HARNESS_SERVER: `node ${server}` },
      abortController: ac,
    },
  });

  // Start the session.
  const first = await q.next();
  assert.equal(first.done, false);

  // Fire an interrupt the server will never answer, then abort.
  const pending = q.interrupt();
  ac.abort();

  await assert.rejects(pending, (err) => err instanceof AbortError);
});

test("a partial env option is merged onto process.env (PATH survives)", async () => {
  // The server fails to even spawn if PATH is dropped, because resolving
  // `node` relies on PATH. We pass ONLY LITE_HARNESS_SERVER in env; if the
  // merge works, process.env.PATH carries through and the server runs.
  const server = writeServer(
    "echo-server.mjs",
    `
import { createInterface } from "node:readline";
function send(o){ process.stdout.write(JSON.stringify(o)+"\\n"); }
const rl = createInterface({ input: process.stdin });
rl.on("line",(line)=>{
  const t=line.trim(); if(!t) return;
  let m; try{ m=JSON.parse(t);}catch{return;}
  if(m.type==="control_request"){
    send({type:"control_response",response:{request_id:m.request_id,subtype:"success"}});
    return;
  }
  if(m.type==="user"){
    setImmediate(()=>{
      // Prove PATH survived by echoing its presence.
      const hasPath = typeof process.env.PATH === "string" && process.env.PATH.length>0;
      send({type:"system",subtype:"init",session_id:"s1",model:"fake"});
      send({type:"result",subtype:"success",session_id:"s1",duration_ms:1,duration_api_ms:1,is_error:false,num_turns:1,total_cost_usd:0,usage:{},result:String(hasPath)});
    });
  }
});
rl.on("close",()=>process.exit(0));
`,
  );

  const q = query({
    prompt: "hi",
    // Deliberately a PARTIAL env: only the server selector, no PATH.
    options: { env: { LITE_HARNESS_SERVER: `node ${server}` } },
  });

  let result;
  for await (const msg of q) {
    if (msg.type === "result") result = msg;
  }
  assert.ok(result, "expected a result message");
  assert.equal(result.result, "true", "PATH should have been merged from process.env");
});
