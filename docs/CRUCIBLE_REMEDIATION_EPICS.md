# Crucible — remediation epics and stories

Seven epics closing the seventeen gaps in [`GAP_REGISTER.html`](GAP_REGISTER.html). Written in
the same form as [`CRUCIBLE_EPICS_AND_STORIES.md`](CRUCIBLE_EPICS_AND_STORIES.md) and numbered
to continue from it: E13 onward.

Every story here is remediation of something already built. That changes how they should be
read — there is a working system underneath, and the risk is no longer "will it work" but "will
changing it break something that currently does". Each epic therefore states what it must not
disturb.

---

# Part I — How this plan was made

## I.1 The ordering rule

The gap register ranks by **what an item would cost on the night**. This plan orders by something
slightly different: **what has to be true before the next thing can be trusted**. The two mostly
agree, and where they differ the second wins.

Concretely: G1 (unverified citations) is first in both. But G2 (unenforced config pinning) rises
above G3 (discovery outside the batch), because putting discovery into the batch without fixing
the pin would add a *third* way for two runs to differ without anyone noticing.

## I.2 Three findings that shaped the grouping

**The gaps are not independent, and three of them share a root.** G2, G3 and G11 are all the same
shape: work that happens outside the run ledger is work nobody can account for. Fixing the ledger
properly closes all three, and fixing them separately would produce three partial answers.

**Two gaps are about enforcement, not features.** G1 and G2 both describe a commitment the
codebase *states* — in a schema comment, in a column comment — and does not *enforce*. That is a
distinct category and it deserves a distinct response: not "add the missing feature" but "make the
existing claim true, and add a test that fails if it stops being true".

**Five gaps are capability that exists and cannot be reached.** G9, G10, G12, G14 and G17 all have
working API endpoints and no interface. These are cheap, and they are the ones an operator feels
every single time. They should not be starved by the harder work.

## I.3 What this plan deliberately does not do

Three capabilities the reference implementation has are **not** being added, and the reasoning is
recorded here so the decision is not silently revisited:

| Not doing | Why |
|---|---|
| Model-driven finding deduplication | A deterministic match on `(kind, label, path)` answers "what changed" without a model call. Spending a call to classify NEW/UPDATE/DUPLICATE buys nothing a join cannot give. |
| An adversarial second-opinion pass | Possibly worth it for cut-band scores, but it doubles the cost of the most expensive calls and its value is unmeasured. **Revisit after calibration has run once** — the report will say which dimensions disagree most with people, and that is the evidence needed to decide. |
| Prompt packs and manual discovery upload | Solves a real problem (a repository the server cannot clone) that has a simpler answer first: tell the team at submission time that we could not clone it, while they can still fix it. That is G14. |

---

# Part II — Sequencing

## II.1 Dependency graph

```
        ┌──────────────────────────┐
Wave 1  │ E13 Evidence integrity   │  (G1)            independent, highest value
        │ E14 Runs that mean       │  (G2, G6)        must precede E15
        └───────────┬──────────────┘
                    │
        ┌───────────▼──────────────┐
Wave 2  │ E15 Discovery at scale   │  (G7, G3, G11)   needs E14's pinning
        │ E19 Operator readiness   │  (G15, G16, G17) independent, small
        └───────────┬──────────────┘
                    │
        ┌───────────▼──────────────┐
Wave 3  │ E16 Discovery as evidence│  (G5, G8, G12)   coverage means little before E15
        │ E18 Committee workbench  │  (G9, G10)       independent
        └───────────┬──────────────┘
                    │
        ┌───────────▼──────────────┐
Wave 4  │ E17 Team identity        │  (G4, G13, G14)  largest schema change; do last
        └──────────────────────────┘
```

## II.2 Why this order and not severity order

**E14 before E15.** Discovery becoming a batch stage means a fourth thing that can differ between
two runs. Fixing the pin first means it arrives already accounted for.

**E19 early, despite being all Low.** It is a day and a half, it is entirely additive, and it
makes the event setup checklist real. Leaving small operational gaps until last is how they arrive
on the night.

**E17 last, despite containing a High.** It is the only epic that rewrites how an existing entity
is identified, on tables that already hold data. Everything else in this plan is additive or
internal. Doing it last means the migration lands against a system whose other moving parts have
settled.

## II.3 Effort

| Epic | Gaps | Size | Estimate |
|---|---|---|---|
| E13 Evidence integrity | G1 | L | 3–4 d |
| E14 Runs that mean something | G2, G6 | M | 2–2.5 d |
| E15 Discovery at cohort scale | G7, G3, G11 | L | 3–4 d |
| E16 Discovery as governed evidence | G5, G8, G12 | M | 2 d |
| E17 Team identity | G4, G13, G14 | L | 3 d |
| E18 The committee's workbench | G9, G10 | L | 3 d |
| E19 Operator readiness | G15, G16, G17 | M | 1.5 d |
| | | | **~18–20 d** |

---

# Part III — The epics

## E13 — Evidence integrity

**Goal.** Make the system's central claim true: that a cited file and line can be checked, and
that a fabricated citation cannot survive.
**Closes:** G1. **Depends on:** nothing. **Size:** 3–4 d.
**Must not disturb:** the non-score vocabulary, or the rule that a failure is never a zero.

Every score and every finding carries `path`, a line range and an `excerpt`. The schema enforces
that those fields are present and well-formed. **Nothing enforces that they are real.** A model
can cite `src/auth/session.ts:42–58` with a plausible invented excerpt, and Crucible will store
it, render it to a reviewer, and reproduce it verbatim in the team's appeal packet.

The fix is deterministic and cheap, because the full scan is already persisted.

### E13-S01 — The citation verifier · M · 1d

*As a reviewer, I want a cited location checked against the source it claims to come from, so that
a citation I do not have time to open is still worth something.*

A pure function in `@crucible/scoring`, used by both scoring and discovery. One implementation,
two callers — a second copy is how the two drift apart (P1.5).

**Acceptance**

1. Takes a `ScanResult` and a citation (`path`, `lineStart`, `lineEnd`, `excerpt`) and returns one
   of three verdicts, with a reason:
   - `VERIFIED` — the path is in the scan, the range is within that file, and the excerpt is
     present at or near those lines.
   - `UNVERIFIABLE` — the path is not among the files the scan read. **This is an honest outcome,
     not a failure:** the file budget legitimately stops short, and `budgetTruncated` already
     records that.
   - `CONTRADICTED` — the path is in the scan, and the range or the excerpt does not hold.
2. Excerpt matching normalises whitespace and strips ellipsis markers before comparing, because a
   model trimming a long line is not fabricating.
3. Matching tolerates a configurable line drift (default ±3). An off-by-two citation is a nuisance;
   treating it as fabrication would reject honest work.
4. Pure and model-free: no database, no I/O, unit-testable against a fixture scan.
5. Distinguishing `UNVERIFIABLE` from `CONTRADICTED` is the point of the story. Collapsing them
   would either excuse fabrication or punish a truncated budget.

### E13-S02 — A contradicted citation fails the score · M · 1d

*As an organiser, I want a scoring response that cites something untrue to be rejected, so that a
fabricated citation cannot become a score.*

**Acceptance**

1. Every citation on a scoring response is verified before the score is stored.
2. A response containing any `CONTRADICTED` citation is treated as a validation failure and
   retried, with a new failure class (`CITATION_UNVERIFIED`) whose retry plan is distinct from
   every existing one — reinforcing that citations must come only from the excerpts supplied.
3. After attempts are exhausted the criterion is `SCORING_FAILED`, **never a zero and never a
   score with the bad citation removed.** A response that fabricated one citation has not earned
   trust in the rest of itself.
4. `UNVERIFIABLE` citations do not fail the score. They are stored with their verdict, and the
   rationale is unaffected.
5. Every verdict is persisted per citation, not recomputed at read time — a reviewer and an
   appeal packet must see the same verdict months apart.
6. The retry plan is distinct from every other class, asserted by the existing test that all
   plans differ.

### E13-S03 — Discovery drops a contradicted finding and says so · S · 0.5d

*As a reviewer, I want one bad citation not to cost me an entire concern, and not to disappear
silently either.*

Discovery needs different handling from scoring, and the difference is structural: a criterion is
one judgement, so a bad citation taints it; a concern is a list, so one bad entry taints one entry.

**Acceptance**

1. A `CONTRADICTED` finding is dropped from the stored set and counted on the concern.
2. The count appears on the concern's note and in the UI — a finding removed without trace is a
   silent edit to the evidence.
3. If **every** finding in a concern is contradicted, the concern is `FAILED`, not `NONE_FOUND`.
   A model that fabricated all of them told us nothing about the repository.
4. `UNVERIFIABLE` findings are kept and labelled, because a budget that stopped short is a fact
   about our reading.

### E13-S04 — Verification is visible where judgement happens · S · 0.5d

*As a reviewer, I want to know which citations were machine-checked, so I spend my attention on
the ones that were not.*

**Acceptance**

1. Each cited excerpt shows its verdict in the team review page and the discovery page.
2. `UNVERIFIABLE` is worded as a statement about our reading — "this file was outside what the
   scan read" — never as doubt about the team.
3. The appeal packet reports the verdict alongside each citation, and states how many citations in
   that evaluation were verified. This **strengthens** the packet: it converts "here is a quote"
   into "here is a quote we checked against the commit you submitted".
4. No verdict is rendered as a bare icon or colour alone (P5.5).

### E13-S05 — A provider that lies · M · 1d

*As a maintainer, I want the fabrication case exercised, so that the defence cannot rot.*

The containment suite already does this for hostile submissions. This is the same idea aimed at
the model rather than at the code.

**Acceptance**

1. A fixture provider that returns well-formed, schema-valid responses with citations to files
   that do not exist, to lines beyond the end of a real file, and with excerpts that appear
   nowhere.
2. Each is proven to be rejected, and the criterion proven to land on `SCORING_FAILED` rather
   than any score.
3. A fixture whose citations are honest but whose file lies outside the budget is proven to be
   **accepted** and labelled `UNVERIFIABLE`.
4. The suite runs in CI alongside the existing gates.

---

## E14 — Runs that mean something

**Goal.** Make "pinned per run" true, so that two runs are comparable and a mid-run configuration
change cannot silently reshape half a cohort.
**Closes:** G2, G6. **Depends on:** nothing. **Size:** 2–2.5 d.
**Must not disturb:** in-flight run resumption, or the existing `pinned_config` shape more than
necessary.

`run.pinned_config` exists and its comment states the commitment: *"a config change must not
affect an in-flight run."* Two things are wrong. It holds four keys — concurrency limits and cost
ceilings — and **no feature flags and none of the settings that decide an outcome**. And it is
written and never read: the scoring path resolves configuration live, so a change during a run
does affect that run.

### E14-S01 — Pin everything that decides an outcome · S · 0.5d

*As an organiser, I want the run to record the settings it ran under, so that two runs can be
compared honestly.*

**Acceptance**

1. The snapshot is **derived from the configuration declaration**, not hand-listed. A hand-listed
   set silently stops covering settings added later — the same failure the test-database reset
   already had to fix once.
2. Every feature flag is included. `feature.discovery.enabled` changing between two runs is
   exactly the kind of difference this exists to catch.
3. Every outcome-determining setting is included: context budgets, cut line, cut band, variance
   threshold, minimum cohort size, and the model assigned to each registered call key.
4. `score_run` carries the same snapshot, because `score_run` is what the variance comparison
   joins on.

### E14-S02 — Honour the pin · M · 1d

*As an operator, I want a configuration change I make at 2am not to alter the run already in
flight.*

This is the story that matters. The rest of the epic is recording; this is enforcement.

**Acceptance**

1. Configuration inside a run resolves through that run's snapshot, not through a live read.
2. The mechanism is ambient, carried the way the correlation id already is — so a service does not
   have to thread a config object through every call, and cannot forget to.
3. A read of a key absent from the snapshot is an error, not a silent live fallback. A silent
   fallback would reintroduce the bug for exactly the settings nobody remembered.
4. Work outside a run keeps reading live configuration; nothing about ad-hoc use changes.
5. Proven by a test that changes a setting mid-run and asserts the run's behaviour does not move.

### E14-S03 — Comparing two runs reports drift · S · 0.5d

*As a reviewer, I want to be told when two runs were not executed alike, so I do not read a
configuration change as model instability.*

**Acceptance**

1. The variance comparison reports which settings differ between the two runs.
2. When any differ, the comparison is labelled **not like-for-like**, and that label travels with
   the flags wherever they are shown.
3. The calibration gate records the snapshot it vouched for, and a ranking computed under a
   materially different one says so rather than relying on the gate's verdict silently.
4. "Materially different" is defined by the declaration, not by a hand-maintained list of which
   keys matter.

### E14-S04 — `reviewer_model` is named for what it does · S · 0.25d

*As a maintainer, I want the schema to stop implying a review pass that does not exist.*

**Acceptance**

1. `reviewer_model` is renamed `fallback_model` in the column, the type and the configuration key,
   with a migration that carries existing values across.
2. Its comment states that it is the model the retry ladder switches to, and that **no
   second-opinion pass exists anywhere in the system**.
3. The question of whether an adversarial review pass on cut-band scores is worth its cost is
   recorded as an open decision, to be answered with calibration evidence rather than by
   intuition.

---

## E15 — Discovery at cohort scale

**Goal.** Make discovery something that can be run over fifty submissions without fifty manual
actions and without leaving the cost accounting.
**Closes:** G7, G3, G11. **Depends on:** E14. **Size:** 3–4 d.
**Must not disturb:** the per-concern outcome vocabulary, supersede semantics, or the rule that
nothing discovers implicitly.

Discovery runs seven sequential model calls inside one HTTP request — up to twenty minutes against
a thirty-second platform timeout. It is not a batch stage, so a fifty-team cohort needs fifty
manual triggers and any that are missed produce submissions scored on less context than their
competitors. And because it opens no ledger run, its spend sits outside every cost ceiling.

### E15-S01 — Discovery opens a run · M · 1d

*As an operator, I want to start a discovery and close the tab.*

**Acceptance**

1. Discovery opens a ledger run, returns immediately, and reports progress per concern through the
   existing progress hub.
2. Progress is **persisted as well as published** — a websocket message is gone on reload, which
   is when somebody checks.
3. Its spend accrues to that run, bringing it under the per-run cost ceiling automatically.
4. A run interrupted part-way is resumable: completed concerns are not redone.
5. It remains an explicit action. **Nothing discovers as a side effect of scanning or scoring** —
   that constraint is unchanged and is asserted by the existing test.

### E15-S02 — Discovery is an optional batch stage · M · 1d

*As an operator, I want a cohort discovered in one action, before it is scored.*

**Acceptance**

1. `discovery` joins `scan`, `probe` and `score` as a stage, with its own concurrency limit
   because it is provider-bound rather than disk- or container-bound.
2. It runs **before** score, because scoring reads what it produces.
3. It is opt-in per batch and off by default, preserving the cost decision the feature flag exists
   to make.
4. A per-submission failure is recorded and the batch carries on, as every other stage already
   behaves.
5. Resume skips submissions already discovered in that run; force redoes them. The two stay
   separate actions.

### E15-S03 — Discovery spend is bounded and projected · S · 0.5d

*As an operator, I want to know what discovering a cohort will cost before I start it.*

**Acceptance**

1. A projection before the stage starts, using the same estimator the batch already uses for
   scoring.
2. Exceeding the ceiling **pauses** rather than fails, consistent with every other stage — the
   work already done is worth keeping.
3. A discovery-specific ceiling exists for runs outside a batch, so a manual bulk trigger is
   bounded too.

### E15-S04 — Coverage is reported, and partial coverage is loud · M · 1d

*As a reviewer, I want to know when a ranked field was not evidenced evenly.*

The fairness story of this epic, and the reason it is not merely an ergonomics fix.

**Acceptance**

1. Discovery coverage per cohort — how many submissions were discovered, and how many concerns
   succeeded across them — is available as a read model.
2. A ranking computed over a partially discovered cohort **says so, beside the ranking**, naming
   how many submissions had the extra context and how many did not.
3. The warning distinguishes *nobody was discovered* (consistent, therefore fair) from *some were*
   (inconsistent, therefore not). A uniformly undiscovered cohort needs no warning.
4. Coverage is recorded on the run so the statement remains true when read later.

---

## E16 — Discovery as governed evidence

**Goal.** Put discovery into the record a decision is defended from, and let a reviewer act on
what it found.
**Closes:** G5, G8, G12. **Depends on:** E15. **Size:** 2 d.
**Must not disturb:** the wording rules that keep security observations and claim conflicts from
reading as accusations.

Discovery is reachable from exactly one place: a link on one team's review page. It does not
appear in the appeal packet — so a team disputing a principles score cannot see the map the
evaluator was given — nor in the readiness report.

### E16-S01 — The appeal packet carries what informed the score · M · 1d

*As a team, I want the packet to show me everything the evaluation was given, not only the source
excerpts.*

**Acceptance**

1. Where discovery informed a run, the packet carries the digest that was passed to the principles
   and standards evaluators.
2. It is labelled as **context, not evidence**, in the same terms the prompt uses — so the packet
   does not imply a finding carried more weight than it did.
3. Concerns recorded as not determined appear as such, with the same statement that nothing was
   scored down for them.
4. Where no discovery informed the run, the packet says so plainly rather than omitting the
   section — an omission reads as "there was nothing".
5. The packet stays self-contained and readable without system access.

### E16-S02 — Readiness reports discovery coverage · S · 0.25d

*As an organiser, I want the definition-of-done checklist to cover the evidence base, not only the
scores.*

**Acceptance**

1. An eighth check reporting discovery coverage across the cohort.
2. It reports what it found — "of 50 submissions: 38 discovered" — rather than pass or fail, in
   the form the existing seven use.
3. `UNKNOWN` stays distinct from `FAIL`, and does not count as ready.

### E16-S03 — A reviewer can set an observation aside · S · 0.5d

*As a reviewer, I want to record that I checked a security observation and it was benign, so the
next reviewer does not repeat the work.*

**Acceptance**

1. An observation can be dismissed **with a reason**, enforced by a `CHECK` constraint tying the
   two together — the pattern the review module already uses for score flags.
2. A dismissed observation stays visible, marked, with its reason and who gave it. Hiding it would
   make a checked observation and an unexamined one look identical, which is the confusion the
   tile design works hardest to avoid.
3. A dismissal supersedes rather than deletes.
4. The concern tile stops warning once every observation in it is dismissed, and says why.

### E16-S04 — Re-running discovery reports what changed · S · 0.25d

*As a reviewer, I want to see that a finding is gone, not merely that it is absent.*

**Acceptance**

1. A new run is compared against the one it supersedes by a deterministic match on
   `(kind, label, path)` — no model call.
2. Findings are reported as added, unchanged or disappeared.
3. A disappeared security observation is called out specifically, since that is the case where
   "absent" and "fixed" differ most.
4. Comparison is available on demand, not computed eagerly for runs nobody will compare.

---

## E17 — Team identity

**Goal.** Make a team something the system knows, rather than a string typed into a form.
**Closes:** G4, G13, G14. **Depends on:** nothing technically; sequenced last by risk.
**Size:** 3 d.
**Must not disturb:** existing submissions, the supersede-and-version chain, or the fact that
teams have no Crucible account.

Team identity is `team_name TEXT`, unique per challenge among current submissions. "Night Shift"
and "The Night Shift" are different teams and neither knows it. A team that renames between
versions starts a second lineage. A token is labelled with a team name that is never reconciled
against the name typed into the form, so the audit trail cannot answer *did this team submit with
their own token?*

This epic deliberately does **not** build a roster or a registration flow. The proportionate fix
is to bind identity to the token that already exists.

### E17-S01 — A team is a record, and a token belongs to one · M · 1d

*As an organiser, I want the token I issue to be the team's identity.*

**Acceptance**

1. A `team` table with a stable id, a display name, and a contact.
2. A submission token belongs to exactly one team; issuing a token creates or selects that team.
3. A backfill migration creates a team per distinct `(lower(team_name), challenge_id)` among
   existing submissions and links those submissions to it. **No existing submission is orphaned or
   rewritten** beyond acquiring a foreign key.
4. The display name stays editable; identity is the id, so a rename is a rename and not a new team.
5. Teams still have no account and no password. This is a record, not a login.

### E17-S02 — A submission takes its team from its token · M · 1d

*As an organiser, I want the audit trail to answer whether a team submitted with their own token.*

**Acceptance**

1. Team identity on a submission comes from the verified token, not from typed text.
2. The team name field becomes a display confirmation the team can correct — it no longer decides
   who they are.
3. Resubmission is recognised as the same team by id, so the version chain holds across a rename.
4. An organiser submitting on a team's behalf selects the team explicitly, and the record shows it
   was submitted on their behalf and by whom.
5. The uniqueness rule becomes one current submission per `(team, challenge)`, enforced by the
   database, replacing the case-normalised string index.

### E17-S03 — A team can see their own entry · S · 0.5d

*As a team, I want to check that my submission is still valid without emailing anyone.*

**Acceptance**

1. A token-authenticated lookup returning that team's current submission and its validation state.
2. It returns **only that team's** submission. The token scopes the read, and a test proves one
   team's token cannot read another's.
3. Where validation has failed — the repository went private, the commit was force-pushed — it
   says what is wrong and what to do, while there is still time to do it.
4. Reachable from the submission page without signing in.

### E17-S04 — The form shows the standard · S · 0.25d

*As a team, I want to read the rubric I am about to be judged by, from the page where I submit.*

**Acceptance**

1. The published rubric for the selected challenge is linked from the submission form.
2. The link appears once a challenge is chosen, since the rubric is per challenge.
3. This closes the loop on the precondition already enforced server-side: a published rubric must
   exist before entries are accepted, precisely so teams can read it.

---

## E18 — The committee's workbench

**Goal.** Let the committee do the two jobs the system asks of them without falling back to the
API.
**Closes:** G9, G10. **Depends on:** nothing. **Size:** 3 d.
**Must not disturb:** rubric immutability once frozen, or the ordering constraint that hand
rankings precede machine scoring.

The quality gate flags criteria as `NEEDS_REWRITE` — deliberately, rather than dropping them — and
shows the reviewer exactly why. And then offers no way to rewrite them. Separately, the
calibration workflow, which decides whether the system is fit to eliminate anyone, is entirely
API-only.

### E18-S01 — Criteria are editable on a draft · M · 1d

*As a committee member, I want to fix the criterion the gate flagged.*

**Acceptance**

1. Name, description, evidence specification, the five anchors and the source reference are
   editable on a `DRAFT` rubric.
2. The same checks the principles authoring form already applies: an evidence specification
   substantial enough to select source by, and five anchors that actually differ.
3. Editing a criterion the gate flagged clears the flag, because the flag described the old
   wording. It does **not** re-run the gate automatically — that is the committee's call and it
   costs a model call.
4. A criterion can be added and removed on a draft; weights re-normalise visibly, never silently.
5. A `FROZEN` rubric refuses all of it, at the database layer as it already does.

### E18-S02 — Assembling a golden set · M · 1d

*As an organiser, I want to build the golden set in the application, because it is the evidence
the gate rests on.*

**Acceptance**

1. Repositories can be added to a golden set with a note on why each was chosen.
2. The spread E11-S01 requires — clearly strong, middling, clearly weak, plus the edge cases:
   scaffold-only, excellent code solving the wrong problem, fails to build, very large — is
   **shown as a checklist against the set**, so a thin set is visible before it is used.
3. Sealing the set is explicit and blocks further additions.

### E18-S03 — Independent hand rankings · M · 0.5d

*As an organiser, I want two people to rank the set without seeing each other's answer.*

**Acceptance**

1. Each ranker's order is captured separately and attributed.
2. A ranker cannot see another's ordering before submitting their own. Independence is the whole
   value of the exercise.
3. **Machine scoring of a golden set is refused until at least two hand rankings exist.** The
   ordering constraint moves from documentation into enforcement.
4. At least two rankers, as E11-S01 requires.

### E18-S04 — Running the gate · M · 0.5d

*As an organiser, I want to run calibration and record the decision where everyone can see it.*

**Acceptance**

1. The calibration report is produced from the UI and shows rank correlation, every material
   disagreement with its evidence, run-to-run variance, and which dimensions disagree most with
   people.
2. Gate criteria are captured **before** the report is produced, and the UI enforces that order —
   criteria written afterwards describe whatever the report happened to say.
3. The go/no-go decision is recorded with rationale and actor.
4. A failed gate shows the documented fallback — fully human judging, system for evidence only —
   in the same place, since that is the moment someone needs to read it.

---

## E19 — Operator readiness

**Goal.** Make event setup a thing the application asks for, rather than a set of configuration
keys somebody remembers.
**Closes:** G15, G16, G17. **Depends on:** nothing. **Size:** 1.5 d.
**Must not disturb:** the distinction between `UNKNOWN` and `FAIL` in the readiness report.

Two configuration values ship unset and silently disable things that depend on them:
`scans.event_window` is null, so provenance flagging for out-of-window work cannot function, and
the 40% threshold beside it has nothing to apply to. `event.evaluation_date` is empty, so one of
the seven definition-of-done checks can never pass.

### E19-S01 — Event setup is a surface · S · 0.5d

*As an organiser, I want one place that asks for the facts about this event.*

**Acceptance**

1. Evaluation date and event window are set from the UI, with their consequences stated beside
   them — what the window is used for, what the date gates.
2. Values already set are shown, not hidden behind an edit action.
3. Changing them is audited like any other configuration change.

### E19-S02 — Unset configuration is a readiness finding · S · 0.25d

*As an organiser, I want to be told what I have not configured, before it matters.*

**Acceptance**

1. Unset event configuration appears in the readiness report as a named finding with the action
   that resolves it.
2. It reports `UNKNOWN`, not `FAIL` — nothing has gone wrong, something has not been decided —
   and `UNKNOWN` continues not to count as ready.
3. The finding names the specific setting, so it is actionable rather than a general complaint.

### E19-S03 — A provenance queue · M · 0.75d

*As an organiser, I want to work through flagged submissions as a list.*

**Acceptance**

1. Flagged provenance is listed as a queue, from the endpoint that already returns it.
2. Each entry shows the flag, the evidence behind it, and a link to that team.
3. A flag can be resolved with a reason, and the resolution is recorded — flags are prompts for a
   person, and a queue with no way to clear an entry is not a queue.
4. The framing stays as E04-S06 requires: these are **flags, never exclusions**. Nothing here
   removes a submission.

---

# Part IV — Cross-cutting definition of done

Every epic above is done when all of the following hold, not only its own acceptance criteria:

1. `pnpm verify` passes — guards, lint, typecheck, build, and the full test suite.
2. The end-to-end suite passes.
3. Tests exist at every level the change touches: unit for pure logic, integration for anything
   that reaches the database, API for a contract change, web for a component, E2E for a journey.
4. Any new model call is a registered key with a stored, versioned prompt — asserted by the
   existing CI gate.
5. Any behaviour a reader would find surprising is explained in the code, at the place where the
   surprise is.
6. `docs/BUILD_LOG.md` records what broke during the work and why, not only what was built.
7. The corresponding entry in `GAP_REGISTER.html` is struck through or removed, with the commit
   that closed it.

---

# Part V — Risks in this plan

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | **E14-S02 changes how every service reads configuration.** An ambient resolver that misses a call site reintroduces the bug for exactly the setting nobody remembered. | **High** | Make an unsnapshotted read an error rather than a silent fallback, so a missed call site fails loudly in test rather than quietly in production. |
| R2 | **E17's backfill runs against real submissions.** A wrong grouping merges two teams or splits one. | **High** | Group by the existing uniqueness rule exactly, so the backfill cannot disagree with what the database already enforced. Report the grouping for review before it is applied. |
| R3 | **E13 could reject honest citations.** A too-strict excerpt match turns a trimmed quote into a fabrication and fails a legitimate score. | Medium | Normalise before comparing; tolerate line drift; and make the drift configurable so it can be loosened without a deploy. The adversarial suite in E13-S05 covers the opposite direction. |
| R4 | **E15 puts discovery under a cost ceiling that has never been exercised at scale.** A ceiling set too low pauses a cohort mid-run on the night. | Medium | Project before starting, and pause rather than fail so raising the ceiling resumes. Size it from the dry run (E11-S04), not from an estimate. |
| R5 | **E16-S01 puts more into the appeal packet.** A packet that grows without limit stops being readable, which defeats it. | Low | Digest only, capped as the prompt digest already is; findings stay in the system for anyone who wants the full list. |
| R6 | **Seven epics is more than one person finishes before an event.** Partial delivery could leave a half-migrated state. | Medium | The wave structure exists for this. Each wave is independently shippable, and E17 — the only one that rewrites existing data — is last precisely so it can be dropped without stranding anything. |

---

*Written against the implementation verified by `pnpm verify` — 1,675 tests across 95 files, plus
119 end-to-end journeys. Gap identifiers refer to [`GAP_REGISTER.html`](GAP_REGISTER.html); epic
identifiers continue the numbering in
[`CRUCIBLE_EPICS_AND_STORIES.md`](CRUCIBLE_EPICS_AND_STORIES.md).*

---

# Part VI — What was built

All seven epics are complete. The plan's own definition of done (Part IV) was applied to each:
`pnpm verify` and the end-to-end suite green, tests at every level the change touched, new model
calls registered with stored prompts, and a `BUILD_LOG.md` entry recording what broke as well as
what was built.

| Epic | Closes | Delivered |
|---|---|---|
| E13 Evidence integrity | G1 | Citation verification against the scan, with `VERIFIED` / `UNVERIFIABLE` / `CONTRADICTED` and the truncation distinction that stops a model citing unread files |
| E14 Runs that mean something | G2, G6 | `affects_outcome` on `app_config`, pinned resolution at the single read point, unpinned outcome reads an error rather than a live fallback; `reviewer_model` renamed to `fallback_model` |
| E15 Discovery at cohort scale | G3, G7, G11 | Discovery inside the batch, asynchronous and resumable, under the cost ceiling, with coverage reported as NONE / PARTIAL / COMPLETE |
| E16 Discovery as governed evidence | G5, G8, G12 | Discovery on the decision surfaces, a deterministic run-to-run diff, and dismissal that supersedes with a reason enforced by the database |
| E17 Team identity | G4, G13, G14 | A `team` record the token belongs to, submissions keyed on identity rather than a typed name, a team's own scoped status lookup, and the published rubric linked from the form |
| E18 The committee's workbench | G9, G10 | Criterion editing on draft rubrics, and the whole calibration sequence in one place |
| E19 Operator readiness | G15, G16, G17 | Unset event configuration reported as UNKNOWN and counted against readiness; a provenance queue that can be worked |

**Verified at completion:** `pnpm verify` clean — **1,950 tests across 113 files** — plus **160
end-to-end journeys**.

**One item was raised during the work and has since been decided.** G18 in the gap register: the
Worker / Reviewer / Judge pattern P4.3 requires for CRITICAL artifacts is not applied to the four
scoring call keys. Applying it roughly triples the dominant spend of an evaluation. The project
owner decided **not** to apply it, and the departure is recorded as a reasoned exception in
[ADR 0004](adr/0004-no-reviewer-judge-for-scoring.md) rather than left as a principle that reads
as met and is not.

P4.3 was amended to scope itself to `llm_call_registry.requires_review` — the single place the
rule is declared — and the exact set of reviewed keys, plus the stated reason each CRITICAL key is
exempt, is pinned by `reviewRequirement.test.ts`. A CRITICAL call key added later without a review
pass appears in neither list and fails by name.

**R2 was honoured.** The plan's highest risk was E17's backfill running against real submissions
and merging two teams or splitting one. The mitigation required the grouping to be reported for
review before being applied: it was applied to a scratch database seeded with the awkward cases —
a team that renamed between versions, a case variant, the same name under two challenges, a token
matching two teams, and a token matching none — and the grouping checked case by case. The build
log records what it produced.
