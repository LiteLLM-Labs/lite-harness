# lite-harness

One server. Pick any harness, pick any model. Durable sessions, UI, and debugging out of the box.

Built for scale — will eventually get to 10K RPS.

## Layout

```
harnesses/    one folder per supported harness (opencode, claude-agent-sdk, openai-agents)
ui/           Next.js chat UI for talking to sessions
VISION.md     what this repo is and why
DESIGN.md     design system for the UI
```

See [VISION.md](VISION.md) for the pitch and [harnesses/README.md](harnesses/README.md) for adding a new harness.
