# Infisical Agent Vault

Route agent traffic through [Infisical Agent Vault](https://github.com/Infisical/agent-vault) so API keys never live in your environment. Agent Vault sits between agents and upstream APIs, intercepts outbound requests, and injects real credentials at the network layer — agents only ever see placeholder values.

---

## How it works with lite-harness

lite-harness runs agents in two modes:

| Mode | What to do |
|------|-----------|
| **Sandbox** (E2B / Daytona) | Set `VAULT_URL` — harness injects `HTTPS_PROXY` inside the VM automatically |
| **Local** (opencode / claude-code) | Wrap `start-local.sh` with `agent-vault run --` |

---

## Sandbox mode

Start Agent Vault and note its proxy port (default: `14322`). Then set on your lite-harness server:

```bash
VAULT_URL=http://<agent-vault-host>:14322
VAULT_PROXY_TOKEN=<agent-vault-token>   # embedded as basic-auth password
```

The sandbox provider reads `VAULT_URL` at creation time and passes into the VM:

```
HTTPS_PROXY=http://x:<token>@<agent-vault-host>:14322
HTTP_PROXY=http://x:<token>@<agent-vault-host>:14322
```

Use placeholder values for any key Agent Vault will inject — it swaps them before forwarding upstream:

```bash
LITELLM_API_KEY=__litellm_api_key__
ANTHROPIC_API_KEY=__anthropic_api_key__
VAULT_URL=http://<agent-vault-host>:14322
VAULT_PROXY_TOKEN=<agent-vault-token>
```

---

## Local harness mode

Wrap the launch script with the `agent-vault` CLI. It sets `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, and `SSL_CERT_FILE` automatically:

```bash
agent-vault run -- ./start-local.sh
```

Set placeholder values in your shell before running:

```bash
export LITELLM_API_KEY=__litellm_api_key__
export ANTHROPIC_API_KEY=__anthropic_api_key__
agent-vault run -- ./start-local.sh
```

---

## Checklist

- [ ] Agent Vault server running and reachable from where agents execute
- [ ] Real credentials stored in Agent Vault, not in `.env`
- [ ] Placeholder values set for every key Agent Vault will inject
- [ ] `VAULT_URL` + `VAULT_PROXY_TOKEN` set (sandbox) or `agent-vault run --` used (local)
