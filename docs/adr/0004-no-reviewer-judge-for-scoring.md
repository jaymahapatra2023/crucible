# ADR 0004 — No Reviewer / Judge pass on the scoring calls

**Status:** accepted · **Date:** 2026-09-23 · **Supersedes nothing · Amends P4.3**

## Context

P4.3 requires a Worker / Reviewer / Judge sequence for every artifact classified `CRITICAL`: a
primary model generates, a second model independently reviews, a third compares and decides. The
principle names six call keys as CRITICAL.

Four of them are the calls that actually produce scores:

| Call key | What it decides |
|---|---|
| `scoring.criterion` | A criterion score, 0–4, with its evidence |
| `scoring.engineering` | The engineering-quality dimension |
| `scoring.principles` | Conformance to each declared principle |
| `scoring.standards` | Conformance to each declared standard |

None of them has a review pass. Rubric synthesis does — `rubrics.criteria_review` and
`rubrics.criteria_judge` are registered call keys with stored prompts, and
`rubrics.criteria_generate` is the only registration carrying `requires_review = true`.

This was found while closing G6, where a `reviewer_model` column was named for a pass that never
ran. Renaming the column to `fallback_model` made the schema honest and left the substantive
question open: should the scoring calls get the pattern the principle demands?

It was recorded as **G18** in the gap register and put to the project owner rather than decided
by the implementer, because it is a cost decision rather than a correctness one.

## Decision

**Crucible does not apply Worker / Reviewer / Judge to the scoring calls.** The pattern remains
mandatory for rubric synthesis, which is where it is currently applied.

P4.3 is amended rather than quietly departed from: the principle now scopes itself to the
artifacts that carry `requires_review` on `llm_call_registry`, which is the single place the rule
is declared, and names the scoring keys as a reasoned exception pointing here.

## Why

**The cost is concentrated exactly where the pattern would apply.** Scoring is the dominant spend
of an evaluation — one `scoring.criterion` call per criterion per submission, times two runs, plus
the three dimension-level calls. Adding a reviewer and a judge to those four keys roughly triples
the largest line item in the budget. Rubric synthesis, by contrast, runs a handful of times per
challenge, which is why the pattern is affordable there and was applied there first.

**A score is not the kind of artifact the pattern was written for.** W/R/J earns its cost on a
single, long-lived, high-leverage artifact that everything downstream depends on — a rubric is
written once and applied to every submission, so an error in it is an error in every score. A
criterion score is one of hundreds, is bounded to 0–4, is constrained by five written anchors,
and is already cross-checked by mechanisms a reviewer pass would partly duplicate.

**Scoring already carries controls that a reviewer would otherwise provide**, and several of them
are stronger than a second model's opinion because they are deterministic:

- **Citation verification against the scan** (E13). Every cited path, line range and excerpt is
  checked against the actual scanned source. A fabricated citation is `CONTRADICTED` and the
  attempt is retried with the rule that was broken named in the reinforcement. This is the single
  failure a reviewer pass would most likely be asked to catch, and it is caught by reading the
  repository rather than by asking a model whether it believes itself.
- **Three validations, not one** (P4.1): schema, content, and semantic — the last recorded as
  `SEMANTIC_INVALID`, distinctly from a malformed response.
- **Deterministic evidence selection.** The model never chooses which evidence it is shown.
- **Temperature 0 and a per-run config pin** (P4.4, E14), so a score is reproducible.
- **The double score run** (E06-S06) with variance flags. This measures reproducibility across
  runs, which W/R/J does not do, and it is explicitly *not* a substitute — but it does surface
  the instability that a review pass would be hoped to reduce.
- **The calibration gate** (E05). The system's ranking is compared against a committee's hand
  ranking on a golden set before it is allowed to rank anything for real. If single-pass scoring
  does not track human judgement, the gate is what says so, and a `NO_GO` falls back to human
  judging rather than proceeding.
- **Human review of the cut band** (E08, plan §IV.5.6). Every placement near the cut line is
  decided by a person with the evidence in front of them, and every caveat must be answered
  before readiness passes.
- **Non-scores, never zeros** (P5.1). A criterion that could not be evidenced is recorded as
  `INSUFFICIENT_EVIDENCE` and excluded, not scored badly. The failure mode a reviewer would guard
  against — a confident wrong number — is structurally harder to produce here than a refusal.

**The benefit is unmeasured.** No golden set has been ranked yet, so there is no evidence about
where, or whether, single-pass scoring disagrees materially with a committee. Implementing the
pattern first would spend the budget on an assumption. The calibration gate exists to produce
exactly that evidence, and E18 built the workbench for running it.

## What this does not change

- The pattern stays **mandatory** for `rubrics.criteria_generate`. Where `requires_review` is
  true it is not optional, does not silently degrade, and all three outputs are stored separately.
- The scoring keys stay classified **CRITICAL**. Criticality governs retry policy, terminality
  and logging; it is not a synonym for "reviewed".
- No control listed above is weakened to pay for this. The exception removes a control that was
  never built; it does not trade away one that was.

## Consequences

**Accepted risk.** A single model's judgement on a criterion stands unless a deterministic check
or a human catches it. The realistic failure is a *defensible but debatable* score — a 3 where a
committee would say 2 — rather than a fabricated one, because fabrication is what the citation
verifier and the semantic validation exist to catch. A debatable score near the cut line reaches
a human by design; one far from the cut line does not change an outcome.

**This decision is reversible, and cheaply.** Adding review is a registration, a stored prompt
and a `requires_review` flag — the machinery is already built and in use for rubric synthesis.

**What would change the answer.** Calibration showing material disagreement between the system's
ranking and the committee's, concentrated in one dimension or one call key, is the evidence that
would justify the cost — and it would justify it *for that key*, not for all four. The gate's
`material_disagreements` and `rank_correlation` are the measures to read.

## Guarding it

The exception is pinned by a test rather than left in prose. `llm_call_registry.requires_review`
is the one declaration; a test asserts the exact set of keys that carry it, so a future CRITICAL
call key added without a review pass fails a named test and has to be a decision rather than an
oversight. That is the same mechanism the P8.1 public-route allow-list uses, and for the same
reason: a rule nobody can accidentally break is worth more than a rule written down.
