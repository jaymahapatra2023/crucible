# TECH_DEBT — `scans` module

Per P13.1. _Last reviewed: 2026-09-22._

## Open items

| # | Principle | Item | Why it exists | Owner | Target |
|---|---|---|---|---|---|
| 1 | P11.1 | `POST /submissions/:id/scan` clones and scans synchronously and will exceed 3 s on a large repository. | Single-submission scanning is an explicit operator action. Cohort scanning goes through the run ledger in E10, which is where the async path belongs. | Engineering | E10-S01. |
| 2 | E04-S04 #3 | Budget truncation is recorded and exposed but not yet shown on any review screen. | The acceptance criterion defers the display to E08-S06. `GET /api/v1/scans/coverage` is ready for it. | Engineering | E08-S06. |
