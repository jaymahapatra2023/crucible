# Calibrating Crucible for codeLinc 11 — the plan

Event: 3–4 October 2026. This plan runs 30 September – 2 October.

Calibration answers one question: **does Crucible's ordering track a committee's closely enough
that the cut line can be trusted?** Until a `GO` decision exists, ranking is refused. The
[runbook](RUNBOOK.md) is the mechanics; this is the plan for these two challenges, and the
reasoning behind the choices in it.

---

## 1. Why the set has to be built, not found

The two paths are *Dental Benefits Optimizer* and *Life Insurance Needs Analyzer*. No public
repository implements either. Adjacent projects — a generic insurance chatbot, a cost calculator —
would all land in the same narrow band on the challenge-fidelity criteria, and a set with no
spread cannot show whether the machine separates the range.

The previous attempt (golden sets 4 and 5, both `NO_GO`) shows the other half of the problem. Its
repositories were real, but the "hand rankings" were one author's, derived from repository
metadata — stars, recency, archived status — not from reading eleven codebases. The recorded
rationale says so. That measured the method, not the machine.

So: **sixteen small applications written to land in a known band, with known defects, ranked by
three people who read them.** The intended answer exists by construction; the rankers verify it
independently; the gate then measures agreement between people and machine on a set where we know
what the truth is.

## 2. What gets built

Eight repositories per challenge. Eight is the floor the readiness check enforces, and all four
required edge cases must appear or the set will not seal.

| Slot | Band | Edge case | Design |
|---|---|---|---|
| 1 | STRONG | — | All three core requirements. Arithmetic in a pure, tested module; the model only explains. Keys from the environment. Honest disclaimers. README that runs. One stretch or bonus item done well. |
| 2 | STRONG | — | As above, thinner tests, one bonus item missing. Distinguishable from slot 1 only by reading. |
| 3 | MIDDLING | — | Requirements met on the surface, but every figure comes from model output; no code computes anything. The defect the engineering criteria exist to catch. |
| 4 | MIDDLING | VERY_LARGE | Solid entry plus a vendored dependency tree and a large data file, to exercise the scan budget. |
| 5 | WEAK | — | A chat wrapper: a system prompt, no calculation, no sequencing. Plus a committed API key and wholesale logging of the user's answers. |
| 6 | WEAK | SCAFFOLD_ONLY | Framework starter with a renamed title and nothing else. |
| 7 | WEAK | FAILS_TO_BUILD | Correct code, broken manifest. Must read as a build failure, never as a judgement on the team. |
| 8 | MIDDLING | WRONG_PROBLEM | A well-built application solving the *other* path's problem. The clearest test of whether fidelity is being measured at all. |

Two design rules across the set:

- **Zero third-party dependencies.** The prober runs every build with `--network none`
  (`sandboxPolicy.ts`; `probes.egress_allow_list` is empty). A `COMMAND` build of `npm ci` cannot
  reach a registry and would fail for a harness reason, not a team one — and seven of eight
  repositories would then grade `BUILD_FAILED`, destroying the spread on the RUNS dimension.
  Node 22 gives an HTTP server, `fetch` and a test runner in the standard library, which is
  enough for all sixteen. Slot 4 vendors its dependencies deliberately, which is also how a real
  team would have to submit one.
- **No model call on the start path.** A repository that needs a live API key to boot cannot be
  probed. Each carries a recorded-response mode so the application starts and answers in the
  sandbox, with the real provider path behind a flag. This is what a team should do too, and the
  engineering criteria reward it.

Where they live: a **temporary GitHub project** under `jaymahapatra2023`, public only for the
scoring window, then private. Names are neutral and mention neither codeLinc nor the challenge
titles. A participant finding them during that window is unlikely but not impossible, and the
window is hours, not days.

## 3. What only people can do

Three rankers (confirmed), which is above the floor of two and materially better: with three, one
outlier does not decide the correlation.

1. Each reads their challenge's eight repositories and submits an ordering, best first. The
   repositories are small on purpose: roughly 90 minutes per set.
2. **Independently.** The application shows a ranker only their own ordering while the set is
   open, because independence cannot be restored once lost. The CLI takes the ranker as a flag
   and will not stop anyone undermining that by other means.
3. Each ranker gets a one-page reading guide stating what the rubric asks and nothing about which
   repository is which.

Then, before any report exists, the thresholds are recorded. Proposed:

| Threshold | Value | Why |
|---|---|---|
| Minimum rank correlation | 0.70 | Below this the ordering is not tracking the committee's. |
| Maximum material disagreements | 2 | A correlation of 0.71 can hide the strongest entry ranked last. |
| Rank gap counting as material | 3 places | Adjacent swaps in the middle are noise; three places crosses a band. |
| Maximum run-to-run variance | 10 points | Reproducibility is a separate control from agreement. |
| Fallback | Fully human judging for the whole event, Crucible for evidence only | Written while losing is still hypothetical. |

## 4. The model path, and what it costs in time

You chose the local CLI over an API key. That is the sequential path: rubric generation took
**9m 38s** for one challenge. Scoring is heavier — roughly thirteen criteria per submission plus
originality and the principles pass.

| Work | Estimate |
|---|---|
| One submission scored | 6–8 minutes |
| One set, one run (8 submissions) | ~1 hour |
| Both sets, both runs (32 submission-scorings) | **4–5 hours** |

That fits one overnight run. Two consequences: `llm.concurrency` should be lowered from 8 to
avoid eight concurrent CLI processes, and the batch must be started with time to spare, because a
pause resumes without redoing completed work but still costs the wall clock. If the gate fails and
criteria need rewriting, a second pass is another 4–5 hours — which is why the schedule below has
the first run tonight, not tomorrow.

## 5. Sequence

| When | What | Who |
|---|---|---|
| 30 Sep, evening | Build and push sixteen repositories. Write both bootstrap files and the reading guides. | me |
| 30 Sep, overnight | `calibration bootstrap` both sets, then `score --run 1` and `--run 2` for each. | me |
| 1 Oct, morning | Three rankers read and submit. `calibration readiness` confirms nothing is missing. | rankers |
| 1 Oct, midday | `calibration criteria` records the thresholds. Then `calibration report` for both sets. | me + you |
| 1 Oct, afternoon | Read the per-dimension figures. If a dimension disagrees with people, rewrite those criteria on a draft, re-freeze, re-score that set. | me |
| 2 Oct | `calibration decide` — `GO` or `NO_GO`, with a rationale, for each set. Then turn the bypass off. | you |
| 2 Oct | Delete the golden submissions' teams if you want them out of the roster view; the sets themselves stay as the record. | me |

## 6. A defect this planning found, and fixed

`eligibleSubjects` selected **every** VALID submission for a challenge. Golden repositories are
entered through the ordinary submission path — deliberately, because that is what makes
calibration measure the real pipeline — so they are VALID submissions against the same challenge
the teams enter. A real cohort run on the night would therefore have scored the reference
repositories alongside the entrants and **ranked them with them**: the cohort size that drives
percentile normalisation would have been wrong, and a reference repository could have displaced a
team at the cut line.

Fixed in migration 091. Calibration publishes `v_calibration_golden_submission`; the batch
excludes those submissions; and the run that *does* score them names them explicitly
(`BatchInput.submissionIds`), so the only way to reach a golden entry is to ask for it by id.
Six regression tests in `goldenSetIsolation.test.ts` pin both halves, including the cohort count.

## 6a. What building it actually found

The set was built, pushed and scored on 30 September. Three findings, in descending order of
consequence:

1. **The sandbox forced `--workdir /work` onto Dockerfile-built images**, so any submission whose
   image declares `WORKDIR /app` and starts with a relative `CMD` was graded "built successfully
   but did not stay running". All eight dental references graded `BUILDS_ONLY`, including the two
   written to run. Fixed; the runs dimension now discriminates `RUNS` / `BUILDS_ONLY` /
   `BUILD_FAILED` as designed. This would have mis-graded most teams on the night.
2. **A build failure costs only 15%.** Reference A7 — the full implementation with one broken line
   in its Dockerfile — ranked 4th of 8 on the first run. If the rankers put it last, raise the
   runs weight before the event rather than explaining the disagreement away.
3. **The hand-rankings-before-scoring rule is not enforced**, though the epic says it is and the
   runbook instructs the opposite order. The control that matters is enforced: no report without a
   sealed set, and no sealing without the rankings. See the build log entry for the detail.

## 6b. The machine side, as measured (30 September)

Both sets scored twice through the full pipeline — clone, scan, probe, score, rank — at **$44.46**
for the four runs. Set A is golden set 1 (cohort `set-a`), set B is golden set 2 (cohort `set-b`).

**Reproducibility is strong.** Every one of the sixteen entries held the *same rank* across both
runs of its set. The largest composite movement was 4.1 points and most were under 2.5, well
inside the 10-point threshold proposed above. Whatever else the report says, the system is
measuring the same thing twice.

**Set A (dental), run 1**

| Rank | Entry | Built as | Composite | Runs |
|---|---|---|---|---|
| 1 | A4 | large, otherwise complete | 91.8 | 100 |
| 2 | A1 | full implementation | 91.1 | 100 |
| 3 | A2 | full core, thinner | 86.3 | 100 |
| 4 | A7 | **does not build** | 75.6 | 0 |
| 5 | A8 | **solves the other problem** | 64.2 | 100 |
| 6 | A3 | figures from the model | 39.9 | 100 |
| 7 | A6 | scaffold only | 34.6 | 50 |
| 8 | A5 | chat wrapper, committed key | 21.3 | 100 |

**Set B (life cover), run 1**

| Rank | Entry | Built as | Composite | Runs |
|---|---|---|---|---|
| 1 | B4 | large, otherwise complete | 92.2 | 100 |
| 2 | B1 | full implementation | 89.4 | 100 |
| 3 | B2 | full core, generic trade-offs | 88.9 | 100 |
| 4 | B8 | **solves the other problem** | 77.7 | 100 |
| 5 | B7 | **does not build** | 73.2 | 0 |
| 6 | B3 | form and a model answer | 41.9 | 100 |
| 7 | B6 | scaffold only | 30.6 | 50 |
| 8 | B5 | chat wrapper, committed key | 22.8 | 100 |

The bottom four are right in both sets, and the top three are the three real implementations. The
three things to put in front of the rankers are in the middle.

### The three disagreements to expect

1. **An entry that does not build still ranks fourth or fifth.** A7 and B7 are complete, correct
   implementations with one broken line in the Dockerfile. Runs scored 0 and it cost them about
   fifteen points. If the rankers put them last, the runs weight is too low for this event.
2. **"Solves the wrong problem" is punished on one rubric and not the other.** A8 — a life tool
   judged by the dental rubric — scored **12.0** on challenge fidelity, which is right. B8 — the
   dental tool judged by the life rubric — scored **61.3**, which is not. The life criteria are
   written about conversation mechanics (collects six inputs, adapts, explains its arithmetic,
   allows revision, calm tone, careful with personal data) and a well-built conversational tool
   about *any* financial subject satisfies six of the eight. Only the two term-versus-permanent
   criteria failed it. The dental criteria are tied to dental specifics — plan terms, procedure
   codes, the annual maximum — and discriminate properly. If the rankers put B8 near the bottom,
   the life rubric needs at least two criteria that cannot be met without actually doing life
   insurance needs analysis.
3. **Bulk did not hurt.** A4 and B4 are the full implementations plus a vendored dependency tree
   and a 9,000-row data file, and both ranked first. Whether a reader should mark that down for
   obscuring the team's own work is a judgement, and the rankers' answer is the one that counts.

### What is outstanding

Readiness on both sets reports one thing and only one thing: **0 of 2 hand rankings.** Entries,
bands and all four edge cases are in place; both sets are unsealed and waiting.

## 7. Risks, stated plainly

- **A set built with model assistance may be easier for the scorer to read than student code
  written at 3am.** This is the honest limit of a constructed set. Mitigation: if you have two or
  three real entries from a previous codeLinc, add them. The challenge differs, so they calibrate
  the engineering, originality and runs dimensions rather than fidelity — which are exactly the
  dimensions a constructed set is weakest at calibrating.
- **`NO_GO` is a legitimate outcome.** Two of two previous attempts failed. If the third does, the
  fallback applies and the event is judged by people with Crucible supplying evidence. That is not
  a failure of the event; it is the control working.
- **Three days.** If the first report fails on a rewritable criterion, there is room for one
  iteration and no more. If it fails on something structural, take the fallback rather than
  tuning thresholds to pass — a threshold chosen to clear a number it already knows is not a
  threshold.
- **Cost.** Sequential CLI calls are free of API charge but not of time, and the 4–5 hour estimate
  assumes the machine is otherwise idle. It is currently running another project's servers.
