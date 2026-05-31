# Infisical Agent Vault

Keep API keys out of your environment entirely. [Infisical Agent Vault](https://github.com/Infisical/agent-vault) runs as an HTTPS proxy — agents send requests with dummy placeholder values, and Agent Vault swaps in real credentials before forwarding upstream. Your keys live only in Agent Vault, never in `.env` or your deployment config.

---

## Sandbox mode (E2B / Daytona)

This is the zero-file-change path. lite-harness automatically injects `HTTPS_PROXY` into every sandbox VM when `VAULT_URL` is set — no Dockerfile edits required.

### 1. Run Agent Vault

On any host reachable from your lite-harness server:

```bash
# Install
curl -sSL https://github.com/Infisical/agent-vault/releases/latest/download/install.sh | sh

# Start (default proxy port: 14322, management port: 14321)
agent-vault server
```

Open the management UI at `http://<host>:14321`, create a vault, and add your credentials (e.g. your LiteLLM key, Anthropic key).

### 2. Set env vars on lite-harness

```bash
VAULT_URL=http://<agent-vault-host>:14322
VAULT_PROXY_TOKEN=<agent-vault-token>
```

That's it. When lite-harness creates an E2B or Daytona sandbox, it automatically passes:

```
HTTPS_PROXY=http://x:<token>@<agent-vault-host>:14322
HTTP_PROXY=http://x:<token>@<agent-vault-host>:14322
```

Every outbound call the agent makes inside the sandbox routes through Agent Vault, which injects real credentials before forwarding.

### 3. Use placeholders for injected keys

Set dummy values for any key Agent Vault will replace:

```bash
LITELLM_API_KEY=__litellm_api_key__
ANTHROPIC_API_KEY=__anthropic_api_key__
VAULT_URL=http://<agent-vault-host>:14322
VAULT_PROXY_TOKEN=<agent-vault-token>
```

Agent Vault matches the placeholder strings against your vault entries and substitutes real values at request time.

### Deploying on Render

Set the four vars above in your Render service's environment panel. No other changes needed.

If you need Agent Vault itself on Render, deploy it as a separate private service (not exposed publicly) on the same Render network — use the internal hostname (`<service-name>:<port>`) as `VAULT_URL`.

---

## Local harness mode

For local development, wrap the launch script with the `agent-vault` CLI. It sets `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, and `SSL_CERT_FILE` automatically so Node.js trusts the proxy's TLS cert:

```bash
export LITELLM_API_KEY=__litellm_api_key__
export ANTHROPIC_API_KEY=__anthropic_api_key__
agent-vault run -- ./start-local.sh
```

---

## Checklist

- [ ] Agent Vault running and reachable from the sandbox VMs (not just localhost)
- [ ] Credentials added to vault via management UI
- [ ] `VAULT_URL` and `VAULT_PROXY_TOKEN` set on lite-harness
- [ ] Placeholder values set for every key Agent Vault will inject
