# ADR 0003 — Repository discovery

**Status:** accepted · **Date:** 2026-09-23

## Context

Crucible scores submissions against a rubric. It does not, today, describe what a submission
*is*: its API surface, its data model, what it integrates with, what capabilities it implements.
A reviewer opening a team's page sees scores and evidence excerpts, and must read the repository
themselves to answer "what did they actually build?".

The upstream reference implementation has a mature discovery capability — roughly 8,200 lines
across nine services — that extracts exactly this. It was reviewed in full before this design.

## What the reference implementation does well, and we take

- **Typed, structured findings** rather than prose: endpoints, entities, functions, integrations
  each have a shape, so they can be counted, compared and displayed.
- **Every finding names where it was found.** Traceability is not optional.
- **Database scripts are first-class source.** SQL, DDL and stored procedures encode business
  logic; treating them as documentation loses it. Procedure names alone reveal capabilities.
- **Explicit gaps.** It records what it could *not* determine and needs a human for, rather than
  omitting it silently.
- **Source precedence with conflict flagging.** Where documentation and code disagree, code wins
  and the disagreement is surfaced.

## What it does that we deliberately do not

- **One prompt returning eleven shapes at once.** A single malformed response loses the entire
  scan. We issue one focused call per concern, so a failure costs one concern and is recorded as
  such (P4.1). This is more calls and more cost; the trade is worth it for a system whose output
  has to be defensible.
- **Domain-specific vocabularies.** `POLICY_ADMIN | CLAIMS | BILLING` suits an insurance
  portfolio. Hackathon submissions span any domain, so our capability categories are
  domain-neutral.
- **File-level traceability only.** `detected_in: "<filename>"` is not enough for P0 constraint
  2, which requires file *and line*. Every finding here carries a line range and the excerpt.
- **A fabricated result when no model is available.** The reference returns a realistic mock
  scan. For a system that eliminates teams, a plausible fabrication is the worst possible
  failure mode: it is indistinguishable from a real result. Discovery here returns NOT_RUN.
- **A single whole-scan confidence score.** Confidence belongs to a finding, not to a scan.

## Decision

Discovery is a new bounded module (`modules/discovery`) that reads a persisted scan and produces
typed, evidence-bearing findings through the LLM gateway — one call key per concern.

**Discovery is the evidence base the evaluation reads from.** Crucible's purpose is to judge an
application a team built against a challenge — for completeness, innovation, adherence to IT
guiding principles, security, risk and standards. Those judgements are about what the application
IS, and that is what discovery establishes. The criterion scorer reads code excerpts selected for
one criterion; discovery reads the repository for breadth and produces a structured picture no
single criterion's context window would contain.

So the principles, standards, security and risk evaluators consume discovery's findings as
structured context alongside the source excerpts. A principle about input validation is far
better judged against "these fourteen endpoints, four of which take a body parameter and two of
which declare no auth" than against whichever twelve-line windows matched the word "validate".

**Two guards on that.** Discovery is *additional* context, never a replacement for the code: a
finding is a claim about the repository, and the evaluator is still shown the source. And a
concern that could not be extracted is passed as absent, never as "none found" — an extractor
that failed must not read as an application with no endpoints.

**The composite is unaffected where it must be.** Discovery enriches the dimensions that ask what
the application is made of. It does not alter the Runs dimension, which stays objective, and it
does not change how the composite is weighted.

**Discovery is advisory about claims, not authoritative.** The documentation-conflict check
reports that a README claims something the code does not appear to do. That is a prompt for a
reviewer to look, not a finding of dishonesty — a claim may be true of code the scan never read.

## Consequences

- Each extractor is independently failable and recorded as `NOT_RUN`, `FOUND` or
  `INSUFFICIENT_EVIDENCE`. A submission with no discovery is unexamined, never "has none".
- Discovery runs BEFORE scoring in the pipeline, because scoring reads it. A submission whose
  discovery failed is still scored — from source alone, with the gap recorded.
- Findings are stored per scan, so re-scanning a repository supersedes rather than accumulates.
- A run that enables discovery is not comparable with one that did not: the evaluators see more.
  The flag is therefore pinned per run (P4.4) and shown beside the ranking, and a calibration
  gate passed without discovery does not vouch for a run with it.

## As built

The decision above stands. Three details differ from how it was first written, and one
commitment in it is not yet met.

**The outcome vocabulary has four values, not three.** `FOUND`, `NONE_FOUND`,
`INSUFFICIENT_EVIDENCE`, `FAILED`. The draft collapsed the last two, which loses the distinction
between "the extractor read the code and could not answer" and "the call did not complete" —
the first is a statement about the repository's legibility, the second about our infrastructure,
and an operator needs to tell them apart.

`NONE_FOUND` is the more important addition. Zero is a legitimate answer for some concerns and
not for others: an application really can integrate with nothing and really can have nothing
worth flagging, but one with no data model, no endpoints and no stack has almost always been
shown the wrong files. Each concern declares which it is (`emptyIsMeaningful`), and a zero from
a concern where zero is implausible is recorded as `INSUFFICIENT_EVIDENCE` rather than displayed
as a fact about the team's work.

**Discovery does not run inside the scoring pipeline.** The draft had it running before scoring,
automatically. It is an explicit organiser action instead, for the same reason scoring never
scans implicitly: seven model calls per submission across a cohort is a cost that should be
chosen rather than incurred, and a step that fires as a side effect makes spend and timing
unpredictable. Scoring reads whatever discovery exists and says so plainly when there is none —
`discoveryDigestOrAbsent` returns a sentence stating that no pass was run and that this is not a
deficiency in the submission.

**Not yet done: the flag is not pinned per run.** The consequence above commits to recording
whether discovery was enabled for a given scoring run, so that two runs are not silently
compared across different evidence bases, and to showing it beside the ranking. Neither is
built. `run` has no flag snapshot at all — no run in the system records the feature flags it
executed under — so this is a gap in E10/P4.4 that discovery makes visible rather than one
discovery introduced. Until it is closed, a cohort should be evaluated with the flag in one
state throughout, and a calibration gate passed without discovery does not vouch for a run
with it.
