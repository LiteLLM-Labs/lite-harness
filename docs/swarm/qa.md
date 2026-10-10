# Browser verification

Verified the local UI with the real server and built-in simulated demo using Chromium on 2026-10-10. No inference or filesystem work is claimed by the demo.

- Neutral Agent 01–10 identities were confirmed before launch; the scripted demo then chose Peer 01–10 identities and task-derived roles, shown live through identity events.
- Ten agents render from the server's canonical team, with actual assignments, current public work, completed cycle counts, harness marks, and model-provider marks.
- The separate human-results feed and full-result dialog show the coordinator's published updates.
- Election detail shows ten recorded ballots and their reasons. Proposal messages show counted acceptance, disagreement, and abstention totals. Directed peer messages display their recipients.
- Each card opens current output, full public transcript, and messages. Keyboard Left/Right changes tabs; Escape closes the dialog.
- Guidance enters the shared message history. Stop preserves contributions and re-enables launch. Recent runs can be opened and returned from.
- Team settings render ten rows. Changing a harness resets its model to the server-provided default. The initial budget is 600 seconds; a custom seven-minute budget was verified.
- During incoming updates, a transcript reading position of 80px remained at 80px while content height grew from 1184px to 1768px.
- Desktop 1440×900, tablet 834×1112, and phone 390×844 were inspected. Tablet/phone layouts have no horizontal overflow; all ten cards remain inside the brain stage. Small-screen feeds move below the brain instead of shrinking content to unreadable sizes.
- No JavaScript errors during these flows. The deliberate QA server restart produced expected connection-refused/session-expiry network messages; reloading restored the live connection. JavaScript syntax checks pass for app.js, assets/ui.js, and assets/constellation.js. Public-output JSON extraction and counted-vote labels were also checked directly.

Screenshots are actual browser captures. Demo screenshots remain visibly labelled “DEMO · SIMULATED”.

## Final chat-first interface

The latest interface follows the supplied chat-shell reference. The left sidebar has persistent New chat and actual chat history; the center holds user messages and coordinator answers; Subagents opens the ten-peer work list and their shared conversation. Brain switches to the spatial Lens field with original deterministic particles, curved routes, logo clusters, and attached actual work. The prior grid view is no longer the default.

Additional Chromium verification:

- New chat clears and focuses the composer, shows neutral peers, and remains a separate draft while an older chat streams updates.
- Two independent simulated chats ran concurrently. Stopping the selected chat reduced the active count from two to one; the other chat continued.
- Selecting history targets the server's live/saved chat. New chat followed by a late history response was tested with a deliberately delayed real selection response: the new title, typed draft, and composer focus were preserved.
- Per-chat configuration resets on selection; explicit continuation keeps the previous peers and sends parentId. Fresh chats omit parentId (source verified).
- Follow-up directions appear as user bubbles in the main conversation, interleaved with human-facing results. Initial-task filtering does not discard the first retained direction after old messages are pruned.
- Header and inline Subagents controls open the work list. Selecting a peer opens full output/transcript with readable harness and model identity (Claude Code / opus confirmed in the mobile dialog).
- Final mobile layout inspected at 390×844: no horizontal overflow, all ten subagents accessible in the scrolling panel, chat composer remains accessible. Brain expands into a vertically scrollable spatial view with every peer and output capsule visible.
- Source syntax checks pass after the final edits. The shell's npm invocation encountered a broken Homebrew Node dylib; the same repository check passed with the bundled Node runtime.

Final screenshots: `chat-new.jpg`, `chat-new-active.jpg`, `chat-subagents.jpg`, `brain-spatial.jpg`, `mobile.jpg`, `subagents-mobile.jpg`, `agent-detail-mobile.jpg`, `brain-mobile.jpg`. `before-spatial.jpg` preserves the preceding grid layout as the before image. Demo captures remain visibly labelled simulated.
