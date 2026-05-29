// LiteClient — every HTTP/SSE call to a lite-harness server lives here, so the
// command code never touches `fetch` or URL building directly.

export class LiteClient {
  constructor({ url, key }) {
    this.url = url.replace(/\/+$/, "");
    this.key = key;
    this.authHdr = key ? { authorization: `Bearer ${key}` } : {};
  }

  get jsonHdr() {
    return { ...this.authHdr, "content-type": "application/json" };
  }

  // Hostname shown in the welcome box.
  get shortUrl() {
    return this.url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  }

  // Returns the raw Response so callers can branch on `.ok` / status.
  whoami() {
    return fetch(`${this.url}/whoami`, { headers: this.authHdr });
  }

  // First model id the server advertises, or undefined if unavailable.
  async firstModel() {
    try {
      const r = await fetch(`${this.url}/v1/models`, { headers: this.authHdr });
      if (r.ok) { const d = await r.json(); return d?.data?.[0]?.id; }
    } catch {}
    return undefined;
  }

  async listModels() {
    const r = await fetch(`${this.url}/v1/models`, { headers: this.authHdr });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    return (d?.data ?? []).map((m) => m.id).filter(Boolean);
  }

  async createSession(harness) {
    const r = await fetch(`${this.url}/session`, {
      method: "POST",
      headers: this.jsonHdr,
      body: JSON.stringify({ title: "CLI session", harness }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status}${body ? ` — ${body}` : ""}`);
    }
    return r.json();
  }

  async listSessions(harness) {
    const r = await fetch(`${this.url}/session`, { headers: this.authHdr });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const all = await r.json();
    const list = Array.isArray(all) ? all : [];
    return harness ? list.filter((s) => s.harness === harness) : list;
  }

  deleteSession(id) {
    return fetch(`${this.url}/session/${encodeURIComponent(id)}`, {
      method: "DELETE", headers: this.authHdr,
    }).catch(() => {});
  }

  async prompt(id, model, text) {
    const r = await fetch(`${this.url}/session/${encodeURIComponent(id)}/prompt_async`, {
      method: "POST",
      headers: this.jsonHdr,
      body: JSON.stringify({
        model: { providerID: "litellm", modelID: model },
        parts: [{ type: "text", text }],
      }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
  }

  // Open the SSE stream and call `onEvent(ev)` for every parsed event.
  // Reconnects on transient errors; stops when `signal` aborts.
  streamEvents(onEvent, signal) {
    const sseUrl = `${this.url}/event${this.key ? `?key=${encodeURIComponent(this.key)}` : ""}`;
    const loop = async () => {
      try {
        const res = await fetch(sseUrl, { signal, headers: this.authHdr });
        if (!res.body) return;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try { onEvent(JSON.parse(line.slice(6))); } catch {}
          }
        }
      } catch (e) {
        if (e?.name !== "AbortError") setTimeout(loop, 2000);
      }
    };
    loop();
  }
}
