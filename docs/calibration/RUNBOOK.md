# Runbook — moving Crucible from uncalibrated to calibrated

Crucible refuses to rank submissions until somebody has shown that its ranking tracks a
committee's. This is how that is done, in the order the system enforces.

Read it once before the day you need it. Every step below refuses out of order on purpose, and
the refusals are easier to understand when they are not the first time you have seen the sequence.

---

## The three states

| State | What it means | Ranking |
|---|---|---|
| **Uncalibrated** | no gate decision exists | **refused** |
| **Calibrated — GO** | a decision was recorded, verdict GO, under the settings now in force | permitted |
| **Calibrated — NO_GO** | a decision was recorded, verdict NO_GO | **refused** — the recorded fallback applies |

"Calibrated" means *a decision has been recorded*, not *the decision was favourable*. The
readiness report passes on either, because its statement is "passed its gate **or** the fallback
was invoked and recorded". Only a `GO` unlocks ranking.

> **A NO_GO is a legitimate outcome, not a failure to retry until it passes.** That is why the
> fallback plan is written down before the report exists: the plan for losing has to be made
> while losing is still hypothetical.

---

## Before you start

**A challenge with a frozen, published rubric, and an open intake window.** The golden
repositories are entered through the ordinary submission path, so that they are scanned, probed
and scored by exactly the code a real entry meets. Without a published rubric and an open window,
`bootstrap` refuses — and the message is about submissions, which is confusing if you did not
expect the golden set to go through intake.

**A way to reach a model.** Either:

```bash
ANTHROPIC_API_KEY=...     # the HTTP path — preferred
LLM_CLI_BINARY=claude     # a locally installed CLI, for a machine with no key
```

**A file of repositories.** `docs/calibration/golden-set-realworld.csv` is a starting point.
The set must span STRONG, MIDDLING and WEAK, and must include all four edge cases —
`SCAFFOLD_ONLY`, `WRONG_PROBLEM`, `FAILS_TO_BUILD`, `VERY_LARGE` — because those are the
submissions most likely to be scored wrongly, and a set without them tests the easy half.

**Two people.** Not two accounts: two people who will read the repositories and order them
independently. One person's ordering cannot be distinguished from that person's preferences.

---

## The steps

### 1. Build the set

```bash
pnpm calibration bootstrap \
  --file docs/calibration/golden-set-realworld.csv \
  --challenge <id> --actor you@example.com
```

Creates the golden set, adds an entry per row, enters each repository as a submission, and links
each entry to the submission it will be scored as. Note the set id it prints.

### 2. Score it, twice

```bash
pnpm calibration score --set <id> --run 1 --actor you@example.com
pnpm calibration score --set <id> --run 2 --actor you@example.com
```

Twice because the double run measures reproducibility, which is a different control from the
gate and does not substitute for it. Both runs go through the same scanner, prober and scorer an
entry would.

### 3. Rank by hand — independently

Each ranker writes a file: one entry label per line, best first, matching the `label` column.

```bash
pnpm calibration rank --set <id> --ranker alice@example.com --file alice.txt
pnpm calibration rank --set <id> --ranker bob@example.com   --file bob.txt
pnpm calibration readiness --set <id>
```

`readiness` names anything still missing — too few repositories, a missing band, a missing edge
case, an incomplete ordering, fewer than two rankers.

> Rankers must not see each other's orderings. The application enforces this while the set is
> open — a ranker sees only their own — because independence cannot be restored once lost.
> The CLI takes the ranker as a flag and will not stop you undermining it by other means.

### 4. Seal

```bash
pnpm calibration seal --set <id> --actor you@example.com
```

Fixes the human judgement: entries, expected bands and rankings. After this the only thing that
may change is which submission each entry was scored as, because scoring necessarily happens
after the judgement it is being compared against.

### 5. Write the thresholds down — before the report

```bash
pnpm calibration criteria --set <id> --actor you@example.com \
  --min-rho 0.7 --max-disagreements 2 --rank-gap 3 --max-variance 10 \
  --fallback "Fall back to fully human judging for the whole event."
```

The order is the point, and the server enforces it. Criteria chosen once you know the number they
have to clear are not criteria.

### 6. Produce the report

```bash
pnpm calibration report --set <id> --run <runIndexId> --actor you@example.com
```

Three things, because a go/no-go cannot be made from a coefficient alone:

- the **rank correlation**, with its sample size;
- every **material disagreement** individually — a ρ of 0.71 can hide the strongest repository
  being ranked last;
- **agreement by dimension**, weakest first, which is usually more actionable than the composite.

### 7. Decide

```bash
pnpm calibration decide --report <id> --decision GO \
  --rationale "..." --actor you@example.com
```

A person's decision, with a reason, against thresholds that already existed. The decision records
the configuration it was measured under.

### 8. Turn the bypass off

```sql
UPDATE feature_flag SET enabled = FALSE WHERE key = 'feature.calibration.bypass_gate';
```

**This step is the whole point of the preceding seven.** The flag ships ON so that development,
rehearsal and the calibration run itself can rank before any gate exists. With it on, a GO changes
nothing operationally: an uncalibrated system will rank anyway. Calibrating and leaving the flag on
means you did the work and left the enforcement off.

Every ranking performed while it is on is logged as such, so a run that skipped the gate is
visible afterwards rather than indistinguishable from one that passed it.

> **Turn it back ON to calibrate again.** Calibration itself needs to rank — step 2 produces the
> ranking step 6 compares against — so with the flag off and a NO_GO standing, the next
> calibration run pauses at ranking. That is correct behaviour and it is not obvious in advance.
> The order is: bypass on → calibrate → decide → bypass off.

### If a run pauses at the gate

It has not failed. The scores are recorded and the work is kept; resume it rather than starting
over:

```bash
pnpm calibration score --set <id> --run 1 --resume <batchRunId> --actor you@example.com
```

The batch run id is printed with the pause. Resuming skips every stage already completed, so a
pause costs the reason and not the cohort.

---

## After calibration

A batch now finishes by itself: scan, probe, discovery, score, rank, compare the runs, and open a
shortlist. A reviewer arrives at a ranked cohort and moves teams between **shortlist**, **hold**
and **exclude**, each with a reason, each keeping the decision it moved from.

If the gate refuses, the batch **pauses** rather than failing. The scores are real and kept;
recording a decision and resuming finishes the job.

---

## What invalidates a calibration

**Changing a setting that decides an outcome.** A weight, a threshold, a cut line, the
normalisation floor. Ranking is then refused, naming what moved, until either the settings are
put back or the gate is run again under the new ones.

Settings that cannot change an outcome — concurrency, cost ceilings, timeouts — move freely. That
distinction is `affects_outcome` on `app_config`, and it is why raising a ceiling mid-event does
not invalidate anything.

**A gate decision with no recorded configuration** is also refused. "We do not know what it was
measured under" is not "it is fine", and it is the same rule the readiness report keeps when it
declines to count UNKNOWN as ready.

---

## If something refuses

| Message | What it means |
|---|---|
| "has not been shown fit to rank" | no decision exists — start at step 1 |
| "gate was failed" | a NO_GO stands; the recorded fallback applies |
| "under different settings" | an outcome-affecting setting moved since the gate |
| "cannot be tied to a configuration" | the decision predates configuration recording |
| "is not sealed" | step 4 not done — a report against an editable set proves nothing |
| "No gate criteria have been recorded" | step 5 not done, and it must precede step 6 |
| "of 2 hand rankings" | step 3 incomplete |
| "None of this golden set's entries appear in run" | step 1's linking did not complete |

`pnpm calibration status` prints every set, what it is waiting for, and its latest verdict.
