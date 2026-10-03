# ADR 0001 — Provenance of borrowed patterns, and the naming rule

- **Status:** Accepted
- **Date:** 2026-09-22
- **Deciders:** Senior architect

## Context

Crucible's repository scanner, LLM-gateway retry ladder, stage-ledger pattern and the 0–4
anchoring used by its principle and standards evaluators are all derived from an **upstream
reference implementation** — a separate, pre-existing platform that solved adjacent problems.
Reusing those patterns removes weeks of work and, more importantly, reuses designs that have
already survived contact with real repositories.

The build plan's Part I assessed that upstream code directly and concluded: the scanner is a
lift-and-adapt, the scoring engine is a rewrite, and the gateway is a pattern to borrow rather
than a file to copy.

## Decision

**Patterns are borrowed. Names are not.**

1. Nothing in this repository references the upstream product by name — not in code, filenames,
   symbols, comments, table names, configuration keys, or documentation.
2. Borrowed code is renamed to Crucible-native naming *on the way in*, and decomposed to satisfy
   P1.4 at the same time. It never lands as a verbatim copy to be cleaned up later.
3. `pnpm guard:naming` walks the whole tree — filenames and file contents — and fails CI on any
   reintroduction of the upstream vocabulary. It is gate 8 of P10.2.
4. Provenance is recorded here, in neutral terms, so that the *history* is not lost even though
   the *names* are.

## Consequences

**Positive.** Crucible reads as its own system. A newcomer is not asked to learn a second
product's vocabulary to understand this one. Extraction of any module into a standalone service
carries no inherited naming debt.

**Negative.** Diffing Crucible against its upstream inspiration is manual — the guard
deliberately prevents the shared identifiers that would have made that mechanical. Accepted:
the two systems diverge immediately anyway, since the scoring engine is a rewrite and the
scanner drops its database coupling entirely.

**A note on honesty.** The guard's banned-term list is assembled from string fragments inside
the guard itself, so the guard does not violate its own rule. That is a deliberate small
awkwardness in service of a rule that is otherwise trivially self-defeating.
