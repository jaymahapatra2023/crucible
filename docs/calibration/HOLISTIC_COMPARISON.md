# Holistic evaluation versus scored criteria — the experiment

The committee asked a fair question. The scoring criteria have never been validated against human
judgement, so why decompose at all? Why not hand the model the brief and the whole repository and
take its overall verdict?

This is the apparatus that answers it with numbers from our own reference sets rather than with
argument. It decides nothing about any team, by construction.

## What was built

| Piece | Where |
|---|---|
| The evaluator: one call, whole repository, no criteria | `calibration/services/holisticEvaluator.ts` |
| The comparison: both rankings, correlated against the humans | `calibration/services/holisticComparison.ts` |
| Its own table, unreachable from any ranking | `holistic_evaluation` (migration 092) |
| The published view for the brief text | `v_challenges_brief` |
| Commands | `pnpm calibration holistic` and `pnpm calibration compare` |

The prompt is in the database like every other prompt, versioned and content-hashed, as
`scoring.holistic`. It states the five-band scale, tells the model that **absence is a finding**
because it can see the whole repository, and requires it to return a null score with
`INSUFFICIENT_CONTEXT` rather than guess. It has no criteria, no anchors and no dimensions: that is
the approach being tested.

## Three guarantees, each pinned by a test

1. **It cannot decide anything.** The result lands in `holistic_evaluation`. Nothing reads that
   table into a composite, a ranking or a shortlist. A test asserts `criterion_score` and
   `submission_composite` are untouched by a holistic pass.
2. **A failure is a failure.** An unusable reply is recorded as `EVALUATION_FAILED` with a null
   score, and a model that declares it cannot judge is recorded as `INSUFFICIENT_CONTEXT`. Neither
   becomes a zero. That is the same rule the per-criterion path follows, and for the same reason.
3. **It refuses to pronounce early.** With fewer than two hand rankings, `compare` reports the two
   orderings and says the question is not decidable. Two opinions with nothing to check them
   against are not a result.

## What the comparison reports

- **Each approach against the committee.** The figure that settles it.
- **Each approach against its own second pass.** The figure people forget to ask for. An approach
  that beats the other on one run and not the next has not beaten it.
- **The two approaches against each other**, and the entries where they disagree by the most
  places, so a reader can adjudicate the specific cases by eye.
- **How much of the repository each holistic call actually saw** — files shown, files in the scan,
  bytes, and whether the budget cut it short. A comparison that sent all of one repository and
  half of another would prove nothing, so the row says which happened.

## Running it

```
pnpm calibration holistic --set 1 --pass 1 --actor you@example.com
pnpm calibration holistic --set 1 --pass 2 --actor you@example.com
pnpm calibration compare  --set 1 --cohort set-a
```

Both passes before comparing: the reproducibility column is empty otherwise.

## The result, 1 October

Both sets, two passes each: 32 evaluations, all scored, **$2.50 in total** against $44.46 for the
four per-criterion runs.

### Reproducibility — each approach against its own second pass

| Set | Per-criterion | Holistic |
|---|---|---|
| A, dental | **1.000** | 0.958 |
| B, life cover | **1.000** | 0.898 |

Per-criterion scoring reproduced its ordering exactly on both sets. The holistic pass did not. It
is close, and close is not the same: an approach that reorders entries between two readings of the
same repository cannot be the sole basis for eliminating a team, however well it correlates on any
one run.

### The two approaches against each other

Set A 0.833, set B 0.571. They disagree substantially, and the disagreements are not noise. They
are each approach's blind spot, and both are now measured.

**The holistic pass cannot see whether the entry runs.** On set B it ranked Reference B7 — the
complete implementation with a broken Dockerfile — **first**, where per-criterion scoring put it
fifth. It reads code and never executes anything, so a repository that cannot start looks
excellent to it. The probe is what catches that, and the probe is not part of either prompt; it
feeds the per-criterion path only.

**Per-criterion scoring is weak on "solves the wrong problem", on the life rubric.** Reference B8
ranked fourth by criteria and seventh by the holistic pass. A8, the same trick on the dental
rubric, ranked fifth by criteria and seventh holistically. The holistic verdict on A8 is worth
reading in the record: it identified a life-insurance calculator submitted against a dental brief,
listed every dental concept absent from the repository, and scored it 3 of 100 at 95% confidence.
The criteria gave it 64.2 because its engineering, principles and runs dimensions were excellent.

### What this says

Neither approach dominates, and they fail in opposite directions. Replacing one with the other
trades a known weakness for a different known weakness.

The conclusion is not "keep what we have". It is that the committee's concern was right about the
criteria and wrong about the remedy: the fix for a fidelity criterion that cannot detect a
wrong-problem entry is to rewrite that criterion, which is a day's work and re-testable against
this same set. The fix for an evaluator that cannot tell whether software runs is not available at
all within the holistic approach, because it is not a prompt problem.

The hand rankings remain the only thing that can say which ordering is actually better. Until they
are in, the figures above compare two machines with each other.

## What it costs, which was the surprise

Measured on Reference A1, the same repository, through both approaches:

| | Calls | Total content sent | Cost |
|---|---|---|---|
| Per-criterion | 14 | 436 KB | about $1.61 |
| Holistic | 1 | 37 KB | $0.09 |

The holistic pass sends **less** in total and costs about eighteen times less. That is the
opposite of the intuition that sending the whole repository must be the expensive option, and the
reason is simple: per-criterion scoring re-sends overlapping excerpts fourteen times, once per
criterion, while the holistic pass sends each file once. Cost is therefore not an argument against
the holistic approach, and it should not be used as one.

## What it is not

It is not a second opinion on any team's score, and it must not become one. If the experiment
shows holistic evaluation tracks the committee better, the response is to change the evaluator
deliberately, re-freeze the rubrics and re-calibrate — not to average the two or to let the
holistic number break a tie. An evaluator nobody can explain is worse than one that disagrees with
you, and a system with two evaluators and no rule for choosing between them has neither.
