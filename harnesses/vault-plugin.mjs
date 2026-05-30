import { AdapterPlugin } from "./plugin-registry.mjs";
import { buildBackend } from "./vault-backend.mjs";

export class VaultPlugin extends AdapterPlugin {
  get name() { return "vault"; }

  async setup({ masterKey }) {
    this._backend = buildBackend(masterKey);
  }

  get backend() { return this._backend ?? null; }

  matches(text, ctx) {
    return text.trim().startsWith("/vault");
  }

  async handle(text, ctx, emitter) {
    const trimmed = text.trim();
    const rest = trimmed.slice("/vault".length).trim();

    try {
      if (!rest) {
        emitter.text(
          "/vault KEY=VALUE            set a secret\n" +
          "/vault KEY=VALUE,K2=V2      set multiple\n" +
          "/vault list                 list key names\n" +
          "/vault delete KEY           remove a key\n" +
          "/vault clear                remove all"
        );
        emitter.done();
        return;
      }

      if (rest === "list") {
        const entries = await this._backend.list();
        if (!entries || entries.length === 0) {
          emitter.text("No secrets stored.");
        } else {
          const lines = entries.map(({ key, updatedAt }) => {
            const date = updatedAt
              ? new Date(updatedAt).toISOString().slice(0, 10)
              : "unknown";
            return `  ${key}  (updated ${date})`;
          });
          emitter.text("Stored secrets:\n" + lines.join("\n"));
        }
        emitter.done();
        return;
      }

      if (rest === "clear") {
        await this._backend.clear();
        emitter.text("✓ Cleared all secrets");
        emitter.done();
        return;
      }

      if (rest.startsWith("delete ")) {
        const key = rest.slice("delete ".length).trim();
        const existing = await this._backend.get(key);
        await this._backend.delete(key);
        emitter.text(existing !== null ? `✓ Deleted ${key}` : `Key ${key} not found`);
        emitter.done();
        return;
      }

      // Set one or more KEY=VALUE pairs
      if (rest.includes("=")) {
        const pairs = rest.split(",");
        const parsed = [];
        for (const pair of pairs) {
          const eqIdx = pair.indexOf("=");
          if (eqIdx === -1) {
            emitter.text(`Error: invalid pair "${pair.trim()}" — expected KEY=VALUE`);
            emitter.done();
            return;
          }
          const key = pair.slice(0, eqIdx).trim();
          const value = pair.slice(eqIdx + 1);
          if (!key) {
            emitter.text(`Error: empty key in "${pair.trim()}"`);
            emitter.done();
            return;
          }
          parsed.push({ key, value });
        }

        for (const { key, value } of parsed) {
          await this._backend.set(key, value);
        }

        const names = parsed.map(p => p.key).join(", ");
        emitter.text(`✓ Set ${names}`);
        emitter.done();
        return;
      }

      // Unrecognized command
      emitter.text(
        "/vault KEY=VALUE            set a secret\n" +
        "/vault KEY=VALUE,K2=V2      set multiple\n" +
        "/vault list                 list key names\n" +
        "/vault delete KEY           remove a key\n" +
        "/vault clear                remove all"
      );
      emitter.done();
    } catch (err) {
      emitter.error(`Error: ${err.message}`);
    }
  }

  async onSessionCreate(session, ctx) {
    // Secrets are available via this._backend for future harness-level injection.
    // Log intent; actual env injection happens at the harness level.
    console.log("[VaultPlugin] onSessionCreate — vault secrets available for injection");
  }
}
