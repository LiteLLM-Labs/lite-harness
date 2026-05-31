# Credential Proxy Integration

Route agent traffic through a credential proxy so API keys never live in your environment. The proxy intercepts outbound requests and injects real credentials at the network layer — agents only ever see placeholder values or nothing at all.

Works with any HTTPS-proxy-based vault: [Infisical Agent Vault](https://github.com/Infisical/agent-vault), [Claw Patrol](https://clawpatrol.dev), or any proxy that speaks `CONNECT`.

---

## How it works with lite-harness

lite-harness runs agents in two modes. Each needs credentials injected differently.

| Mode | How traffic flows | What to set |
|------|------------------|-------------|
| **Sandbox** (E2B / Daytona) | Agent runs in a remote VM | `VAULT_URL` → harness sets `HTTPS_PROXY` inside the VM automatically |
| **Local** (opencode / claude-code) | Agent runs as a child process on the same host | Wrap the harness with the proxy CLI, or set `HTTPS_PROXY` before launch |

---

## Sandbox mode

Set two env vars on your lite-harness server:

```bash
VAULT_URL=http://your-proxy-host:14322
VAULT_PROXY_TOKEN=<token>          # optional — embedded as basic-auth password
```

That's it. The sandbox provider (`E2bProvider`, `DaytonaProvider`) reads `VAULT_URL` at sandbox creation time and injects:

```
HTTPS_PROXY=http://x:<token>@your-proxy-host:14322
HTTP_PROXY=http://x:<token>@your-proxy-host:14322
```

Every HTTP/HTTPS call the agent makes inside the sandbox routes through your proxy. The proxy swaps placeholder values for real credentials before forwarding upstream.

Your `LITELLM_API_KEY` can be a dummy value — the proxy replaces it:

```bash
LITELLM_API_KEY=__litellm_api_key__   # placeholder; proxy injects real key
VAULT_URL=http://your-proxy-host:14322
```

---

## Local harness mode

For local development (`start-local.sh`), the harness process itself makes outbound calls. Wrap the launch command with your proxy's CLI, or set `HTTPS_PROXY` in the shell before starting.

### Option A — process wrapper CLI

Most proxy tools ship a `run` subcommand that bootstraps the child process with proxy settings and the CA cert automatically:

```bash
# Infisical Agent Vault
agent-vault run -- ./start-local.sh

# Claw Patrol
clawpatrol run -- ./start-local.sh
```

The wrapper sets `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, and `SSL_CERT_FILE` for you.

### Option B — set `HTTPS_PROXY` manually

If your proxy doesn't have a wrapper CLI, or you prefer explicit config:

```bash
export HTTPS_PROXY=http://your-proxy-host:14322
export HTTP_PROXY=http://your-proxy-host:14322
export NODE_EXTRA_CA_CERTS=/path/to/proxy-ca.crt  # trust the proxy's TLS cert

./start-local.sh
```

---

## Per-proxy setup notes

### Infisical Agent Vault

1. Start the Agent Vault server and create a vault with your credentials.
2. Set placeholder values in your environment:
   ```bash
   LITELLM_API_KEY=__litellm_api_key__
   ANTHROPIC_API_KEY=__anthropic_api_key__
   ```
3. Point sandboxes at the proxy:
   ```bash
   VAULT_URL=http://localhost:14322
   AGENT_VAULT_TOKEN=<token>
   ```
4. For local harness: `agent-vault run -- ./start-local.sh`

Infisical docs: https://github.com/Infisical/agent-vault

### Claw Patrol

Claw Patrol uses a WireGuard tunnel + TLS MitM rather than an `HTTPS_PROXY` env var, so sandbox mode (which relies on `HTTPS_PROXY` inside the VM) requires the sandbox VM to be enrolled as a device — set up a custom E2B template with the `clawpatrol` binary and join it to your gateway at template build time.

For local harness, the process wrapper works without changes:

```bash
clawpatrol run -- ./start-local.sh
```

Enroll your dev machine once (`clawpatrol join http://<gateway>:8080`) and all local agent traffic is intercepted automatically.

Claw Patrol docs: https://clawpatrol.dev/docs/getting-started/

---

## Checklist

- [ ] Proxy running and reachable from where agents execute
- [ ] Real credentials stored in proxy, not in `.env`
- [ ] `VAULT_URL` set (sandbox mode) or process wrapped / `HTTPS_PROXY` exported (local mode)
- [ ] Proxy CA cert trusted by agent runtime (`NODE_EXTRA_CA_CERTS` or system trust store)
- [ ] Placeholder values set for any key the proxy will inject
