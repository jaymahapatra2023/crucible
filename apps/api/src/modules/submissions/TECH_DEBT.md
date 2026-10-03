# TECH_DEBT — `submissions` module

Per P13.1: known principle violations and consciously deferred work, with the principle
violated, why it exists, who owns remediation, and a target.

_Last reviewed: 2026-09-22._

## Open items

| # | Principle | Item | Why it exists | Owner | Target |
|---|---|---|---|---|---|
| 1 | P11.1 | Repository validation runs synchronously inside the submit request rather than as an async job. | The value of E03-S02 is telling a team their repository is unreachable *while they are still submitting*. A clone takes ~0.5 s; deferring it would mean the team has left before the result exists. Accepted under P13.3. | Engineering | Revisit if p95 submit latency exceeds 3 s during the E11-S04 dry run. |
| 2 | P11.4 | Scheduled re-validation runs on an in-process timer (`platform/jobs/scheduler`) rather than a durable queue with leader election. | Crucible runs one API instance and has one recurring job. Tasks are idempotent and hold no state that matters, so duplication across instances is wasteful but not incorrect. | Engineering | Replace before running more than one instance, or when a second recurring job appears. |
