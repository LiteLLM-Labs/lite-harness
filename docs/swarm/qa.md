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
