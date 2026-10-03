# TECH_DEBT — `rubrics` module

Per P13.1: known principle violations and consciously deferred work, with the principle
violated, why it exists, who owns remediation, and a target.

_Last reviewed: 2026-09-22._

## Open items

| # | Principle | Item | Why it exists | Owner | Target |
|---|---|---|---|---|---|
| 1 | E02-S06 #1 | Criterion add / remove / reorder exist in the API and are tested, but the review UI exposes weight editing only. | Full inline criterion editing belongs with E08's review surface; shipping a partial editor first would mean building it twice. | Engineering | E08. |
| 2 | P11.1 | Rubric synthesis (3 model calls + one per criterion) runs synchronously and can exceed 3 s. | It is an explicit, infrequent organiser action with a visible result. | Engineering | Move behind the run ledger if the committee reports timeouts. |
