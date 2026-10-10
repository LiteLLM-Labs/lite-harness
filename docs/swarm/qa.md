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

Final screenshots: `chat-new.jpg`, `chat-new-active.jpg`, `chat-subagents.jpg`, `brain-spatial.jpg`, `chat-mobile.jpg`, `subagents-mobile.jpg`, `agent-detail-mobile.jpg`, `brain-mobile.jpg`. `before-spatial.jpg` preserves the preceding grid layout as the before image. Demo captures remain visibly labelled simulated.

## Status-first Brain follow-up

- Brain nodes show the agent name, harness/model marks, and explicit Active or Inactive. Output previews, tools and cycle footers were removed from this view; clicking the leader node still opens full output, transcript and messages.
- Actual 30-second demo at 1440×1000: 10 active / 0 inactive after election; one literal LEADER badge on Peer 08 and matching full leader name in the hub. Completed demo: 0 active / 10 inactive, preserving the same leader independently of activity.
- Direct shared-helper checks covered mixed running/working/queued/complete/failed/stopped peers (2 active / 4 inactive), an inactive leader, absent run, coordinator replacement, and complete/failed/stopped/interrupted runs with stale running peers. All passed. Independent review found count/class/canvas consistency.
- Mobile inspection at 390×844 found no horizontal overflow (document width 390). Labels and leader badge remain readable in the vertical constellation.
- All JavaScript source syntax checks passed. No backend or public-server changes were made for this follow-up.
- Captures: `brain-status-active.jpg`, `brain-status-finished.jpg`, `brain-status-mobile.jpg`. All captures are the labelled simulated demo, with no invented mixed-state screenshot.

## Adjustable team size and live additions

- New-chat team settings accept 2–100 peers (the upper bound comes from server defaults), with number/Apply/Done controls and −1/+1/+5/+10 shortcuts. Increasing a customized team from10 to20 preserved the existing custom model. Invalid101 was rejected without changing the10 configured rows. Reset from a stopped51-peer chat restored the default10-row setup.
- Browser-created configured20-agent simulated run elected peer-08. Adding5 through Brain’s Add agents dialog produced25 active nodes and new running peers21–25. The run ID, coordinator ID and exact deadline timestamp were unchanged. Captures: `brain-20-agents.jpg`, `add-agents-dialog.jpg`, `brain-25-agents.jpg`.
- A50-agent simulated run was checked at390×844. All50 Brain nodes fit their expanded stage without overlap/clipping, and document width equalled viewport width390. The last peer opened from both Brain and Subagents, with its actual simulated contribution visible. Capture: `brain-50-mobile.jpg`.
- Adding one peer through Subagents with explicit Swarm native / openai/gpt-6-astra produced peer-51 with the requested harness/model and running status. Its output was visible in the detail dialog; capture `added-agent-mobile.jpg`. The isolated simulation was stopped afterward.
- Draft geometry checks covered20/50/100 peers at widths262–1466, unique IDs and preserved configuration. Browser100-peer mobile check confirmed the last peer was selectable, no horizontal overflow, and canvas backing height capped4096 while DOM labels stayed sharp. Desktop50 and live25 had zero measured overlaps/clipped nodes.
- All JavaScript syntax checks passed; independent review’s Reset and canvas-size findings were fixed. Only isolated QA port4332 was restarted; public4328 was untouched. All QA runs were explicitly simulated and made no inference calls.

## Group conversation and uninterrupted continuation

- Chat now shows canonical peer messages chronologically: contributions, directed messages, assignments, elections, votes, introductions, membership and user guidance. Authors, harness/model marks, recipients, current leader and activity are visible. Results is separate; Brain retains its leader/activity field.
- Actual simulated captures: `group-chat-desktop.jpg`, `group-chat-mobile.jpg`, `group-results-desktop.jpg`, and `continue-chat-mobile.jpg`. Marks were decoded and visibly inspected. Mobile390px had no horizontal overflow. Clicking Peer09 opened its full public output; Escape closed details.
- Guidance appeared as a You message without duplicating the initial task. Results displayed10 answer cards with Group Chat hidden. Live public prose appeared as Writing; raw collaboration envelope fields were not exposed.
- A live reading-position check retained the exact committed message DOM node with0px vertical shift while new messages arrived (338 rows at measurement). Keyed reconciliation keeps unchanged author/logo nodes mounted.
- Deadline-race browser regression: delayed an outgoing A message, stopped A on the QA server, and navigated to existing B. The409 created an explicit follow-up of A with its captured text,10-peer team,600-second budget and file-write setting. Both UI and server selection remained B.
- Normal Send from the stopped main composer continued its exact parent. The terminal Subagents composer also continued its parent and cleared sent text. No Continue-button prerequisite remains. New chat during delayed409 preserved its draft; subsequent Send omitted parentId and used the neutral default team. After stop cleanup settled, input and Send were enabled.
- Continuation QA recorded original normal UI payloads, then added demo:true at the browser transport boundary before forwarding. This exercised real selection/parent handling without inference calls. Screenshots contain actual labelled simulated runs, not injected conversation records. QA simulations were stopped; public4328 and63529 were untouched.
- All source syntax checks and13 chat-feed regressions passed. Cases cover canonical/event deduplication, long and immediate task/guidance distinctions, recipients, partial JSON, retries, terminal output, truthful stream timestamps, and500 stored+100 pending entries. Independent review found no remaining source blocker.

## Local actions, workstreams, file review and stable reading — 2026-10-10

Verified the canonical UI on an isolated loopback server at 4332 with the browser skill, at 1440×1000 and 390×844. Public servers on 4328 and 63529 were not restarted or changed by UI QA.

- Local actions initializes from the server default, displays the actual project path, and keeps a chat's actual `toolsEnabled` mode independent of the next-period switch. Turning the switch off leaves completed enabled work labeled correctly; a fresh draft then shows Inspect only. Demo runs display Simulation. The project path is selectable and copyable.
- A simulated 20-peer run declared three scripted workstreams. Selecting Onboarding showed its seven current members and only messages stamped with that stream, while shared human guidance remains visible. Pure helper checks confirmed that a peer moving streams does not reclassify its historical messages, and that Ungrouped is truthful.
- Review mode kept exactly the same message DOM, HTML and feed height while 84 updates arrived: both scroll and height deltas were zero. Composer stayed enabled. Explicit resume caught up and moved to the newest message. An upward wheel event entered Review. Opening a saved run started in Review. Expanding a message updates only that message in place and pauses live reconciliation. The pending-update toolbar has constant height to prevent a counter appearing from moving the page.
- A clearly labeled no-inference fixture used scripted peers with actual disposable file edits and a real verification command. Changes showed an added README (+3), deleted note (−1), and modified function (+2/−1). Refreshing an unchanged report preserved the exact diff DOM node. Initial loading, pending baselines, frozen reports and unavailable legacy baselines were inspected. Truncated unknown line counts render as unavailable, not zero. A literal script-like diff stayed inert text.
- Read the completed real four-harness evidence from `/private/tmp/swarm-integrated-actions-msRTuw` in a separate copied QA store. The real run's two declared streams, four frozen added files and actual command output were rendered. Pi's command detail showed Completed / Exit 0 and `VERIFIED_peer-04`. No extra inference was triggered by this UI review.
- Desktop/mobile screenshots were visually inspected for clipping and horizontal overflow. Mobile file selection, diff reading, workstream control and review/resume controls fit the viewport. JavaScript syntax checks and all 13 chat-feed regressions passed; workstream membership/history helper assertions also passed.

Final evidence:

- `workstreams-real-desktop.jpg` — actual completed Codex/Pi verification stream and matching members.
- `changes-real-desktop.jpg`, `changes-real-mobile.jpg` — actual four-harness frozen file changes.
- `local-command-real.jpg` — actual successful Pi command and stdout.
- `workstreams-desktop.jpg`, `workstreams-mobile.jpg` — explicitly simulated 20-peer swarm.
- `review-paused-desktop.jpg`, `review-paused-mobile.jpg` — explicitly simulated incoming activity held behind Review.
- `local-actions-desktop.jpg`, `local-actions-mobile.jpg` — project and next-period action controls.
- `changes-fixture-desktop.jpg` — labeled no-inference fixture with real added/modified/deleted files.

The first Changes loading check exposed a null-element scroll restoration guard; it was corrected and the successful initial fetch, file selection and stable refresh were rechecked. A four-pixel review toolbar shift was also corrected; the subsequent measured shift was zero. Baseline snapshots exclude unsupported/private files by backend policy; the UI does not attribute file changes to an agent or workstream.
