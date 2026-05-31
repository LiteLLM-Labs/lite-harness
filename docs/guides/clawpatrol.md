# Claw Patrol

Route agent traffic through [Claw Patrol](https://clawpatrol.dev) so API keys never live in your environment. Claw Patrol intercepts outbound connections via a WireGuard tunnel + TLS MitM, injects credentials at the network layer, and enforces rules — agents have no awareness it's in the path.

---

## How it works with lite-harness

lite-harness runs agents in two modes:

| Mode | What to do |
|------|-----------|
| **Local** (opencode / claude-code) | Enroll your dev machine, wrap `start-local.sh` with `clawpatrol run --` |
| **Sandbox** (E2B / Daytona) | Build a custom sandbox template with `clawpatrol` installed and enrolled |

> **Note:** Claw Patrol uses a WireGuard tunnel rather than `HTTPS_PROXY`, so the standard `VAULT_URL` sandbox path doesn't apply. Sandbox VMs need the `clawpatrol` binary and device enrollment baked into the template.

---

## Local harness mode

### 1. Install and start the gateway

```bash
curl -fsSL https://clawpatrol.dev/install.sh | sh
```

Run the gateway on a host you control (open UDP port 51820):

```bash
clawpatrol gateway --config gateway.hcl
```

### 2. Enroll your dev machine

```bash
clawpatrol join http://<gateway-host>:8080
```

Approve the one-time code in the dashboard. The gateway CA installs into your system trust store — Node.js and curl pick it up automatically.

### 3. Configure credentials in the dashboard

Add your API keys via the dashboard settings page (manual paste or OAuth flow). Claw Patrol supports Anthropic, OpenAI, GitHub, and Notion via OAuth; other services via manual token entry.

### 4. Define rules in `gateway.hcl`

```hcl
endpoint "https" "litellm-gateway" {
  hosts = ["<your-litellm-host>"]
}

credential "bearer_token" "litellm-key" {}

profile "agents" {
  credentials = [bearer_token.litellm-key]
}

rule "inject-litellm" {
  endpoints = [endpoint.https.litellm-gateway]
  verdict   = "allow"
}
```

See the [Claw Patrol config reference](https://clawpatrol.dev/docs/config-reference/) for full rule and credential syntax.

### 5. Wrap the harness

```bash
clawpatrol run -- ./start-local.sh
```

All outbound traffic from the harness and its agent child processes is intercepted. You can omit `LITELLM_API_KEY` from your env entirely — Claw Patrol injects it.

---

## Sandbox mode

Sandbox VMs (E2B / Daytona) run on remote hosts that aren't automatically enrolled. To use Claw Patrol with sandboxes:

1. Build a custom E2B template or Daytona image with `clawpatrol` installed.
2. At template build time, enroll the VM as a device (`clawpatrol join ...`) and bake the enrolled state into the image.
3. Launch the template as normal — the enrolled device routes all outbound VM traffic through your gateway.

> Alternatively, use [Infisical Agent Vault](./infisical-agent-vault.md) for sandbox mode, which works via `HTTPS_PROXY` without template changes.

---

## Checklist

- [ ] Gateway running with UDP 51820 open
- [ ] Dev machine enrolled (`clawpatrol join`)
- [ ] Credentials connected in dashboard
- [ ] Rules configured for your API hosts
- [ ] Harness launched via `clawpatrol run -- ./start-local.sh`
