import { test } from "node:test";
import assert from "node:assert/strict";
import { SLASH_COMMANDS, matchSlash, commandToken } from "./slash-commands.mjs";

const names = (q) => matchSlash(q).map((c) => c.name);

test("/loop is a registered command", () => {
  assert.ok(SLASH_COMMANDS.some((c) => c.name === "/loop"));
});

test("/agent is a registered command", () => {
  assert.ok(SLASH_COMMANDS.some((c) => c.name === "/agent"));
});

test("/a prefix filters to /agent", () => {
  assert.deepEqual(names("/a"), ["/agent"]);
  assert.deepEqual(names("/agent"), []); // complete → closes so Enter sends
});

test("bare slash opens the full menu", () => {
  assert.deepEqual(names("/"), SLASH_COMMANDS.map((c) => c.name));
});

test("prefix filters to matching commands", () => {
  assert.deepEqual(names("/l"), ["/loop"]);
  assert.deepEqual(names("/lo"), ["/loop"]);
  assert.deepEqual(names("/c"), ["/clear"]);
});

test("a complete command closes the menu so Enter sends it", () => {
  assert.deepEqual(names("/loop"), []);
  assert.deepEqual(names("/clear"), []);
});

test("menu closes once args are being typed", () => {
  assert.deepEqual(names("/loop 5m run tests"), []);
});

test("non-command and unknown input yield no menu", () => {
  assert.deepEqual(names("hello"), []);
  assert.deepEqual(names("/xyz"), []);
});

test("commandToken highlights a known command, with or without args", () => {
  assert.equal(commandToken("/lo"), "/lo");          // prefix still being typed
  assert.equal(commandToken("/loop"), "/loop");      // exact command
  assert.equal(commandToken("/loop 5m run ci"), "/loop"); // command + args
});

test("commandToken ignores unknown tokens and plain text", () => {
  assert.equal(commandToken("/xyz"), null);
  assert.equal(commandToken("hello"), null);
});
