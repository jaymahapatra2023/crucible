# TECH_DEBT — `challenges` module

Per P13.1: known principle violations and consciously deferred work, with the principle
violated, why it exists, who owns remediation, and a target.

_Last reviewed: 2026-09-22._

## Open items

| # | Principle | Item | Why it exists | Owner | Target |
|---|---|---|---|---|---|
| 1 | P11.1 | Brief extraction runs inline on upload rather than as a job. | A handful of documents uploaded by a person who is watching; telling them at once that their PDF is a scan beats discovering it when generation produces nothing. | Engineering | Revisit if a challenge ever carries more than a few large artifacts. |
