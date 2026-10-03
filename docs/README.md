# Crucible documentation

Six documents, in the order a newcomer should read them.

| Document | What it is |
|---|---|
| [How Crucible decides](HOW_CRUCIBLE_DECIDES.html) | The pipeline end to end: every stage, which steps a model touches, what stays deterministic, and the guards against hallucination. **Open in a browser.** |
| [Gap register](GAP_REGISTER.html) | What the implementation cannot yet do — 17 verified items ranked by what they would cost on the night. **Open in a browser.** |
| [Architecture principles](ARCHITECTURE_PRINCIPLES.md) | P0–P13. The rules every module is held to, including the CI gates that enforce them. |
| [Epics and stories](CRUCIBLE_EPICS_AND_STORIES.md) | E01–E12 with acceptance criteria, plus the delivery plan and the system-level definition of done (§IV.5). |
| [Remediation epics](CRUCIBLE_REMEDIATION_EPICS.md) | E13–E19: the plan that closes the gap register, sequenced by what must be true before the next thing can be trusted. |
| [Build log](BUILD_LOG.md) | What was built and, more usefully, what broke — the defects found during construction and why they happened. |

Architecture decisions live in [`adr/`](adr/), numbered and dated:

- [0001 — Provenance and naming](adr/0001-provenance-and-naming.md)
- [0002 — Module boundaries and referential integrity](adr/0002-module-boundaries-and-referential-integrity.md)
- [0003 — Repository discovery](adr/0003-repository-discovery.md)

## Reading the two HTML documents

They are self-contained pages — no build step, no server. Open them directly:

```
open docs/HOW_CRUCIBLE_DECIDES.html
open docs/GAP_REGISTER.html
```

Both are generated from the implementation rather than written alongside it: the models,
thresholds and limits they quote were read from the live configuration tables, so they describe
what the system would actually do rather than what it was meant to do. Regenerate them when
behaviour changes — a stale architecture document is worse than none, because it is believed.
