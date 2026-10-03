# TECH_DEBT — `probes` module

Per P13.1. _Last reviewed: 2026-09-22._

## Open items

| # | Principle | Item | Why it exists | Owner | Target |
|---|---|---|---|---|---|
| 1 | P11.1 | `POST /submissions/:id/probe` builds synchronously and routinely exceeds 3 s. | Probing one submission is an explicit operator action. Cohort probing runs through the run ledger in E10. | Engineering | E10-S01. |
| 2 | E05-S05 #1 | Build logs are exposed and audited at the API, but no review screen shows them yet. | The acceptance criterion defers the display to E08-S02. | Engineering | E08-S02. |
| 3 | — | Probing requires a prior scan (the base image comes from the recorded dominant language). | The dependency is real and correct, but it is enforced by producing `UNSUPPORTED` rather than by the orchestrator guaranteeing order. | Engineering | E10-S01 sequences scan → probe → score. |
