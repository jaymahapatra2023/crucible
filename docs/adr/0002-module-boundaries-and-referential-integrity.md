# ADR 0002 — Module boundaries, ports, and where referential integrity lives

- **Status:** Accepted
- **Date:** 2026-09-22
- **Deciders:** Senior architect

## Context

P1.3 forbids cross-module foreign keys, cross-module joins, and one module writing another's
tables. P7 simultaneously demands strong data integrity and end-to-end traceability. Crucible's
domain is highly interconnected: a `criterion_score` references a run, a submission and a
criterion, each owned by a different module.

Read naively, the two principles conflict. Two sub-problems needed deciding.

## Decision 1 — Cross-module references are not foreign keys

A column that points at another module's entity is a plain column. Integrity is enforced:

- at the **service layer**, which resolves the reference through the owning module's published
  view or port before writing;
- by a **scheduled integrity check** (`platform.integrity`) that reports dangling references as
  `traceability_gap` rows rather than letting them accumulate silently.

*Within* a module, foreign keys remain mandatory — `run_stage_result.run_id` is a real FK with
`ON DELETE CASCADE`.

### Why not just use foreign keys?

Because the constraint would have to be dropped the day a module is extracted, and a constraint
that must be dropped under load is worse than one that was never relied upon. The cost — integrity
becomes a runtime property rather than a storage-engine guarantee — is paid down by the scheduled
check, which also surfaces the class of break that a foreign key cannot catch anyway: a score
citing a rubric version that was superseded.

## Decision 2 — Cross-cutting concerns are reached through ports, not imports

Appendix C states plainly: never import a service file from another module's `services/`. But
auditing is needed by nearly every module, and routing every audit write through an in-process
HTTP call to ourselves would be absurd.

Resolution: a **port**. `lib/ports/auditPort.ts` declares the interface. Every module imports
only the port. The governance module registers the implementation once, at boot
(`installAuditPort()`).

This satisfies P1.3 (no cross-module service import, governance still owns `audit_event`) and
P1.2 (extraction is a wiring change — swap the in-process implementation for an HTTP client, and
no call site changes).

The unregistered default is a **loud no-op**: it warns rather than throwing, because a missing
audit sink must not take down the operation being audited, but silence would lose the entire
trail on a misconfigured boot.

## Consequences

Ports are the sanctioned mechanism for any future cross-cutting concern (domain-event publishing
is the next one). The rule to apply: if module A needs *data* from B, use B's published view or
API; if A needs to *invoke a capability* B owns, use a port.
