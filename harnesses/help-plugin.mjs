import { AdapterPlugin } from "./plugin-registry.mjs";

export class HelpPlugin extends AdapterPlugin {
  get name() { return "help"; }

  matches(text, ctx) {
    const t = text.trim().toLowerCase();
    return t === "/help" || t === "/?";
  }

  async handle(text, ctx, emitter) {
    emitter.text([
      "Available commands:",
      "",
      "  /vault KEY=VALUE        store a secret (injected into sandboxes)",
      "  /vault list             list stored secret names",
      "  /vault delete KEY       remove a secret",
      "  /vault clear            remove all secrets",
      "",
      "  /help                   show this message",
    ].join("\n"));
    emitter.done();
  }
}
