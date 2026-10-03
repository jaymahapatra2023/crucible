# Crucible — Build Log

One entry per epic: what was built, what the second review pass found, and every deviation from
the plan with its justification. Deviations are recorded here rather than absorbed silently, so
a later reader can tell a decision from an oversight.

---

## E01 — Foundation · COMPLETE

**Stories:** S01 workspace · S02 database and migrations · S03 configuration and secrets ·
S04 LLM gateway · S05 run ledger.

### Delivered

| Area | What exists |
|---|---|
| Workspace | pnpm workspace, 6 packages + api + web, TS strict + project references, `pnpm dev` runs both |
| Database | 6 forward-only migrations, checksum-guarded runner, advisory lock, `db:reset` with a loopback-only guard |
| Config | Fail-fast env validation naming every problem; all behaviour in `app_config` (P7.5) with TTL + explicit invalidation |
| LLM gateway | Registry, DB prompts, classified retry, JSON repair, schema validation, fallbacks, per-attempt audit, cost attribution |
| Run ledger | `run` + `run_stage_result`, four outcomes, restart-survivable, resume support, WebSocket progress |
| Governance | Append-only audit (DB trigger), identity, RBAC with audited denials |
| CI | 9 gates per P10.2, including three custom guards |

**Tests:** 343 passing across unit / integration / API contract / web, plus 12 Playwright E2E.
Coverage 85.8% lines, 93.6% functions, 87.4% branches — above P10.1's 80% bar.

### What the second review pass found

Six gaps that the first pass had missed, all closed:

1. **No CI workflow** — E01-S01 acceptance 3 requires CI to fail on a type error. Added.
2. **Ledger published no progress** — P5.1 mandates WebSocket progress, not polling. Wired.
3. **The P8.1 allow-list named routes that did not exist** (`/docs`, `/openapi.json`). The
   principles doc warns that a falsifiable allow-list is worse than none, so the list was
   corrected *and* made machine-checked by `authCoverage.test.ts`.
4. **The gateway was never exercised** — no test provider existed. Added, with 20 tests.
5. **No `TECH_DEBT.md` per module** (P13.1). Added.
6. **The ADRs the principles doc referenced did not exist.** Written.

### Defects found and fixed during the build

- **`db:reset` ran on import.** A unit test importing the CLI for its pure guard function
  executed the CLI and began dropping the development schema; only the process exiting first
  saved the data. The guard moved to `db/resetGuard.ts` (pure, side-effect-free), CLIs now
  refuse to run unless invoked directly, and the confirmation bypass was re-keyed from
  `NODE_ENV=test` to "the database name ends in `_test`" — `NODE_ENV` alone let any test runner
  wipe whatever `DATABASE_URL` pointed at.
- **The P8.1 coverage test was vacuous.** It parsed `printRoutes()` text, which splits paths
  across tree indentation and yields trailing segments. Replaced with an `onRoute` registry.
  Investigating it also surfaced that `/ws/progress` was unreachable: the global bearer hook
  rejected the handshake before the route's own query-token check could run.
- **JSON truncation repair deleted real data.** The dangling-key strip also removed a trailing
  complete string *inside an array*. Fixed by tracking container kind, not just depth.
- **`validate()` collapsed zod input and output types**, so every `.default()` field read as
  possibly-undefined at the call site.
- **Vitest's `fileParallelism: false` is ignored inside a workspace project**, so DB-backed
  files truncated tables under each other. Forced a single fork.
- **Testing Library cleanup never registered** without `globals: true`, so renders accumulated
  across tests.
- **Vite binds `localhost` (IPv6) by default**, so anything probing `127.0.0.1` saw a refused
  connection. Bound explicitly.

### Deviations from the plan, and why

| # | Plan said | Built instead | Why |
|---|---|---|---|
| D1 | E01-S04 "thin LLM client" with `callModel({ system, user })` | A gateway: registered `callKey`, DB-stored prompts, per-attempt audit | P3.1–P3.4 require exactly this. Prompts passed as arguments would violate P3.3. The client is thin in code; the governance is not optional. |
| D2 | E04-S02 puts `extractJsonObject` in `packages/scanner` | It lives in `modules/llm/services/jsonExtraction.ts` | P3.1 puts every model call in the gateway, so the scanner is pure static analysis and needs no JSON-from-model parsing. The capability is reimplemented and unit-tested as required (20 tests); only its home differs. **Revisit in E04** — if the scanner turns out to need it, it moves to a shared package rather than being duplicated. |
| D3 | Data model shows foreign keys throughout | No cross-module FKs | P1.3 forbids them. Integrity moves to the service layer plus a scheduled check. See ADR 0002. |
| D4 | — | Cross-cutting concerns reached through ports | Appendix C forbids importing another module's service. See ADR 0002. |
| D5 | — | `TEXT` + `CHECK` rather than native Postgres enums | `ALTER TYPE … ADD VALUE` cannot run in a transaction, which would break E01-S02's idempotency requirement. |
| D6 | — | API on port 3101, not 3001 | 3001 is occupied by an unrelated service on this machine. |
| D7 | — | The principles doc was rewritten Crucible-native | Standing instruction: no upstream-platform reference anywhere. Enforced by `guard:naming` (P10.2 gate 8). |

### Open items carried forward

- `llm.cost_ceiling_usd_per_run` is declared and readable but not yet **enforced** — that is
  E10-S03's story, deliberately not pre-built here.
- The worker/reviewer/judge pattern (P4.3) is declared in the registry schema
  (`requires_review`) but no CRITICAL call key exists yet. First needed by E02-S04.
- `packages/{rubric,scanner,scoring,prober}` are scaffolded entry points only; each is built by
  its own epic.

---

## E02 — Challenge intake and rubric synthesis · COMPLETE

**Stories:** S03 rubric schema (done first, as the plan directs) · S01 challenge upload ·
S02 document extraction · S04 criteria generator · S05 quality gate · S06 review/edit/weight ·
S07 approve/freeze/version · S08 publish.

### Delivered

| Area | What exists |
|---|---|
| Rubric contract | `packages/rubric`: types, validator, stable content hashing, fixtures for both challenges. No database, no network. |
| Challenge intake | Upload with per-file cap, content-addressed retained storage, re-download, soft delete while DRAFT |
| Extraction | One registry, four strategies (Markdown, plain text, DOCX, PDF), section/page markers preserved, per-file failure isolation |
| Generation | Worker → reviewer → judge (P4.3), prompts in the database, weights structurally impossible to generate |
| Quality gate | Per-criterion verdict, one repair attempt, persistent failures surfaced as `NEEDS_REWRITE` and never dropped |
| Review UI | Running weight totals, blocked approval, gate warnings requiring acknowledgement, brief passages behind each `source_ref` |
| Freeze | Content hash at freeze; immutability enforced by a database trigger, not application code |
| Publication | Markdown and HTML export carrying version and hash; the published rubric readable with no account |

**Tests:** 533 passing (unit / integration / API contract / web) plus 21 Playwright E2E.
Coverage 87.8% lines.

### What the second review pass found

1. **E02-S04 #1** — nothing flagged a criteria count outside the requested 5–10. Added an
   advisory rather than an error: returning fewer criteria is the *correct* response to a thin
   brief, and enforcing the range would push the generator into padding (risk R3).
2. **E02-S04 #4** — the model's output was validated, but the *persisted rubric* was never run
   through the E02-S03 validator. Now validated and returned with the result.
3. **E02-S06 #3** — the `source_ref` rendered as a link to `#brief-…`, **an anchor that did not
   exist**. Traceability that cannot be followed is decoration. Added `briefLookup`, two
   endpoints and a UI panel that resolves a reference to the actual passage — and says so
   plainly when it cannot, rather than showing a confident wrong one.

### Defects found and fixed during the build

- **PDF section offsets were computed before normalisation**, so every `source_ref` citing a page
  would have pointed at the wrong text. Found by a test asserting the located slice.
- **The PDF fixture generator allocated colliding object ids** — page 2 reused page 1's font id —
  producing a structurally invalid document that silently lost page 1's text.
- **DOCX extraction leaked Markdown escaping** (`documents\.`) into brief text and quoted refs.
- **`generatedCriterionSchema` expected camelCase while the stored prompt asks for snake_case.**
  Every real generation run would have failed. Bridged with a transform so the model contract and
  the TypeScript types each keep their own convention.
- **The web client set `content-type: application/json` on bodyless POSTs**, so *freeze* and
  *publish* were rejected with 400 — a failure that looks like a permissions problem. Caught only
  by E2E, since Fastify's `inject` does not set that header.
- **Three separate test-isolation defects**, each fixed structurally rather than patched:
  `resetDatabase` enumerated tables by hand (now derived from the schema); it restored only one
  seed migration (now snapshots whatever the migrations declared); and restoring rows with
  explicit serial ids left sequences at 1, so the next insert collided (now resyncs sequences).
- **`locator.all()` does not auto-wait**, so an E2E acknowledgement loop silently did nothing.

### Deviations from the plan, and why

| # | Plan said | Built instead | Why |
|---|---|---|---|
| D8 | E02-S04 "produces 5–10 criteria" | Produces what the brief supports; a count outside 5–10 raises an advisory | Padding a thin brief to reach a quota is exactly the failure R3 warns about. The committee is told; the generator is not pushed to invent. |
| D9 | — | Criterion weights are set one whole dimension at a time | Setting them one at a time guarantees invalid intermediate states and makes "does this dimension sum to 1.0" unanswerable mid-edit. |
| D10 | — | The generator's output schema has no `weight` field at all | F4 invariant 2 says people set weights. Making it unexpressible is stronger than instructing the model not to. |

### Open items carried forward

- `assertScoreable()` is implemented and tested but has no caller yet — E06 is its first
  consumer, and E02-S07 acceptance 5 is satisfied there.
- Criterion **add/remove/reorder** exist in the API and are tested, but the review UI currently
  exposes editing of weights only. Full inline editing belongs with E08's review surface;
  recorded here rather than left implicit.

---

## E03 — Submission intake · COMPLETE

**Stories:** S01 submission form · S02 repo validation at submit time · S03 build declaration ·
S04 window enforcement and lock · S05 intake dashboard.

### Delivered

| Area | What exists |
|---|---|
| Submission | Team name, contact, challenge, repo, build declaration, artifact links; resubmission supersedes and is versioned |
| Validation | Real shallow clone at submit time; host allow-list is configuration; specific, actionable reason for every failure |
| Build declaration | `DOCKERFILE` + path (confirmed present in the repo) or `COMMAND` + command; path-escape rejected at intake |
| Window | Open/close/lock; writes refused outside the window; HEAD SHA of every valid submission recorded at lock |
| Re-validation | Scheduled until the window closes; a regression is logged *and* audited |
| Dashboard | Real backend counts by challenge and status, failures with reason and contact, CSV export |
| Team auth | Scoped, revocable submission tokens (P8.2); only the hash is stored |

**Tests:** 622 passing plus 26 E2E.

### What the second review pass found

1. **E03-S03 #3** — the build-declaration requirement existed in the API and in nothing teams
   could read. A team would have learned the rule by being blocked by it. The rule is now
   published *with the rubric*, in both Markdown and HTML, and only when `RUNS` is actually
   scored.
2. **E03-S02 #4** — `revalidateDue()` existed but **nothing called it on a schedule**, so risk
   R8 (a repository goes private after submission) was unmitigated in practice. Added a
   `platform/jobs/scheduler`, a revalidation job that stops once intake is locked, and task
   health on the health endpoint.

### Defects found and fixed during the build

- **Resubmission was impossible.** `submit()` inserted the new row before standing the old one
  down, colliding with the partial unique index that permits one CURRENT entry per team and
  challenge. The index was right; the ordering was wrong.
- **Intake status reported `NO_WINDOW` after a lock**, because it derived state from the
  *unlocked* window — making a locked event indistinguishable from one that never opened.
- **The P8.1 allow-list matched by path only.** Adding `POST /api/v1/submissions` would have
  exempted `GET` on the same path — which lists every team's name, contact and repository. The
  allow-list is now `METHOD /path`, the principles doc says so, and a test asserts that the
  public POST does not make the GET public.
- **GitHub failure readings were misleading.** A nonexistent repository was reported as "asked
  for credentials, so it is private", sending a team who mistyped a name after the wrong fix.
  Over anonymous HTTPS GitHub genuinely cannot distinguish the two, so the message now says so.

### Deviations from the plan, and why

| # | Plan said | Built instead | Why |
|---|---|---|---|
| D11 | E03-S01 teams submit | Teams submit with a scoped, revocable **submission token**, not an account | Issuing fifty accounts for one evening is all risk and no benefit (P8.2). The token is a named alternate auth factor on the P8.1 allow-list. |
| D12 | — | Validation runs **synchronously** at submit time, despite P11.1's 3-second rule | The entire value of E03-S02 is telling a team *while they are still there*. A clone is ~0.5 s; deferring it to a job would mean the team leaves before learning their repo is private. Recorded as a conscious P13.3 exception in the module's TECH_DEBT.md. |
| D13 | — | Scheduled work runs on in-process timers, not a queue | Crucible has one recurring job. Tasks must be idempotent and safe to run concurrently, and hold no state that matters. Registered as debt: a second instance or a heavier job replaces this with a real queue. |

---

## E04 — Repository scanner · COMPLETE

**Stories:** S01 extract package · S02 vendor helpers · S03 clone and commit snapshot ·
S04 depth profile and file budget · S05 scan persistence · S06 provenance analysis.

### Delivered

`packages/scanner` — **zero dependencies**, no database, no auth, no HTTP, no model calls. 75
tests run against fixture directories with nothing else running (E04-S01 acceptance 5).

| File | Responsibility |
|---|---|
| `scanRepository.ts` | Orchestration and the public entry point |
| `cloneWorkspace.ts` | Ephemeral clone, commit snapshot, guaranteed cleanup |
| `fileGathering.ts` | Deterministic walk, skip lists, budget, priority ordering |
| `depthProfiles.ts` | Three profiles, recommendation, file-priority scoring |
| `repoStats.ts` / `repoMarkers.ts` | Shape without reading content; presence signals |
| `codeMetrics.ts` | Line accounting, test/CI/Docker detection, dependency counts |
| `provenance.ts` | Git history facts and advisory flags |
| `chunking.ts` / `ordering.ts` / `languages.ts` / `skipLists.ts` | Supporting utilities |

API side: `scan` and `provenance` tables, scan service, routes, and published read models.

### Defects found and fixed during the build

- **`hasLockfile` was always false.** Lockfiles are excluded from the file budget, so deriving
  presence signals from the gathered-file list reported every skipped marker as absent — a
  metric that was confidently wrong rather than unknown. Added `repoMarkers`, which checks the
  filesystem directly.
- **Ordering used `localeCompare`, which is ICU- and locale-dependent.** The same repository
  could order differently on different machines, breaking P4.4 and making E06-S06's double-run
  comparison measure the environment. Replaced with a locale-independent comparator everywhere.
- **`force: true` was impossible.** The unique index correctly refused a second completed scan
  at the same commit. Dropping the index would lose the guarantee and overwriting would destroy
  evidence, so a forced re-scan now supersedes the previous scan and keeps it, linked.
- **Priority penalties missed plural directory names** — `examples/` and `fixtures/`, the forms
  actually used, scored as ordinary source.

### Deviations from the plan, and why

| # | Plan said | Built instead | Why |
|---|---|---|---|
| D14 | E04-S01 "lift-and-vendor, not a rewrite" | Re-authored and decomposed into 11 files | The standing naming rule forbids carrying the upstream vocabulary, and the original is a 2,092-line file that would violate P1.4 on arrival. The *design* is lifted; the text is not. |
| D15 | E04-S02 "copy the skip-lists" | Authored Crucible's own | The upstream constants live in a package whose source is not on disk, and they are tuned for enterprise legacy stacks (COBOL, RPG, PowerBuilder) rather than hackathon repositories. |
| D16 | E04-S02 `extractJsonObject` in the scanner | It lives in the LLM gateway (20 tests) | **Confirming E01's D2.** The scanner makes no model calls — P3.1 puts every one in the gateway — so it has no model text to parse. The capability exists, is reimplemented and is tested; only its home differs. |
| D17 | — | The scanner never clones and never persists | Keeping clone, config and persistence in the API is what lets the package be pointed at any directory and tested with nothing running. |
| D18 | — | `.env` files are never read, at all | A real `.env` holds live credentials. Reading one into a scan result would put it in the database and then into a scoring prompt (P8.3). `.env.example` is still read. |

### Forward dependencies recorded

- **E04-S04 acceptance 3** ("truncation surfaced in the UI") is satisfied *by E08-S06* by its own
  wording. The data is ready: `budget_truncated` per scan and a `v_scans_coverage` view, exposed
  at `GET /api/v1/scans/coverage`. E08 must consume it.

---

## E05 — Build and run prober · COMPLETE

**Stories:** S01 sandbox harness · S02 Dockerfile path · S03 command path · S04 probe result and
scoring input · S05 reviewer log access. **Highest security risk in the system (R1).**

### Delivered

`packages/prober` — zero dependencies. Containment is declared in one file (`sandboxPolicy.ts`)
and applies to every strategy, so a new build method cannot accidentally ship without it.

**The controls, all verified against real Docker:**

| Control | Mechanism | Verified by |
|---|---|---|
| One ephemeral container, destroyed regardless of outcome | `--rm`, plus registered teardown | Container listing after a probe |
| No host filesystem mount | tar-over-stdin build context; `docker cp` for commands | Policy asserts no `-v`/`--mount`/`docker.sock`; host-write fixture |
| Network egress denied by default | `--network none`; allowance recorded per probe | Fixture attempts three destinations, all blocked |
| CPU / memory / PID caps | `--cpus`, `--memory` with equal `--memory-swap`, `--pids-limit` | Real fork bomb and memory bomb |
| Hard wall-clock timeout | Harness-side kill independent of the container | A command that never returns |
| No host credentials reachable | Explicit minimal env; nothing inherited | **Host canary variable**, proven invisible inside |
| No privilege escalation | `--cap-drop ALL`, `no-new-privileges`, non-root user | Policy assertions |

**The adversarial fixture is real** (P8.6): a genuine fork bomb, a genuine memory bomb, genuine
network callouts, genuine host-write attempts and genuine environment scraping. Each prints
`ESCAPED` if it gets out; the tests assert it never appears, and that the host filesystem is
untouched afterwards. **41 tests, and the suite fails rather than skips when no runtime is
present.**

### What the second review pass found

**The containment gate was not in CI.** It ran only on a developer machine — precisely what P8.6
forbids, since the evidence has to be continuous to mean anything. Added as a required job that
first asserts `docker version` succeeds, so a missing runtime fails loudly rather than looking
like a flaky test.

### Defects found and fixed during the build

- **The credential fixture reported a false escape.** It flagged `GPG_KEY`, which the *python
  base image* sets. Replaced the name heuristic with a **host canary**: a variable set on the
  host process that must be invisible inside. That tests non-inheritance directly instead of
  guessing which names look sensitive.
- **Base-image selection was arbitrary.** The prober took the first entry of the scan's
  alphabetically-sorted language list, so a TypeScript project with one shell script could be
  built in the wrong image on ordering alone. The scanner already computed the dominant language
  by file count; it is now persisted and used.
- **"Not scanned yet" was reported as "unsupported stack."** Those are different problems — one
  is ours to fix by scanning first — and now say so differently.
- **An identical five-argument log helper existed in both strategies.** Deduplicated.

### Deviations from the plan, and why

| # | Plan said | Built instead | Why |
|---|---|---|---|
| D19 | `build_probe.log_uri` | The log is stored in the database; `log_uri` is reserved | An appeal packet must be reproducible months later without depending on a filesystem a retention policy (OD-6) may have cleared. Logs are capped, so the volume is trivial. |
| D20 | — | `PROBE_ERROR` and `UNSUPPORTED_STACK` score `-1`, not `0` | A harness failure is not the team's fault. E07-S01 excludes these from the denominator instead of scoring them as a failure to build. |
| D21 | — | Disabling probing records `UNSUPPORTED`, never zero | No team should be scored down for a capability the operator switched off. |
| D22 | E05-S03 "same capture and caps as S02" | A successful COMMAND grades `BUILDS_ONLY`, never `RUNS` | A build command describes a build. Only a Dockerfile tells us how to *start* something, so only that path can observe staying up. Grading a build command as "runs" would claim something unmeasured. |

---

## E06 — Rubric scoring engine

**Status: complete.** 944 unit/integration/API/web tests, 41 containment tests against real
Docker, 38 E2E journeys. Guards, lint, build and typecheck clean.

### What was delivered

**E06-S01 — code-bearing context builder.** `packages/scoring/contextBuilder.ts` selects real
source by the criterion's `evidence_spec`, returns line-anchored merged windows, records the
budget it spent, and reports `insufficientEvidence` with the terms it searched for. Widened to an
`EvidenceTarget` so principles and standards use the same builder rather than a second copy.

**E06-S02 — criterion scorer.** 0–4 with confidence, rationale and `{path, line, excerpt}`
evidence. Anchors supplied verbatim. Every row records `rubric_id`, `version` and `hash`.

**E06-S03 — principles and standards evaluators.** Both consume the S01 context. Principles keep
a 0–4 maturity; standards keep COMPLIANT/PARTIAL/NON_COMPLIANT plus NOT_APPLICABLE. Nine pillars
and four standards ship **inactive** (OD-2) — adoption is an audited organiser action.

**E06-S04 — engineering quality.** Metrics plus a review pass, and the metric inputs travel with
the scores to the UI so a reviewer sees what the score was computed from.

**E06-S05 — originality.** Boilerplate share and template detection are now *measured*
(`originalitySignals.ts`, a zero-dependency registry of eight generators) rather than guessed at,
and combined with E04-S06 provenance. Labelled ADVISORY on the page, lowest weight, omitted
entirely when switched off.

**E06-S06 — double run and variance.** Two `score_run` rows per cohort, composite delta per
submission, `straddles_cut` and `exceeds_threshold` flags, and a dismissal that the **database**
refuses without a reason of at least ten characters.

### What the second review pass found

- **`selectOpenFlags` was typed as the table row but reads the view.** The view carries a derived
  `dismissed` boolean and omits the run ids; the code compiled happily and would have handed
  callers `id` and `run_a_id` fields that are `undefined` at runtime. Given its own type — which
  immediately caught a second mistake in `varianceService`.
- **`NUMERIC` columns were typed `string`.** The pool registers a type parser that returns
  numbers. Caught by E2E, where `62.0%` rendered as `62%` — the only test that ran the value
  through the driver, the API and the browser together.
- **Blended weight coverage was a count ratio, not a weight ratio.** It read as coverage on a
  dimension where every other dimension means weight. Now blended by the same split as the score.
- **Dead code removed:** `assertRubricUsable` (superseded by `assertScoreable`),
  `selectDimensionInputs`, `undismissVariance`, `maturityAsPercent`, `fromHundred`.

### Defects found and fixed during the build

- **`resetDatabase()` restored five hand-listed tables.** The principles seeded by migration 024
  vanished after the first truncate, and the failure landed in whichever test needed them. Now
  **every** table holding rows straight after `migrate` is snapshotted and restored, ordered by a
  topological sort of the schema's own foreign keys — alphabetical order fails, because
  `llm_call_config` references `llm_call_registry` and sorts before it.
- **Insufficient-evidence reasons listed alphabetically-first terms** — the least discriminating
  ones. Evidence-spec terms are shown first.
- **Prompts were missing for three registered call keys.** `scoring.principles`,
  `scoring.standards` and `scoring.originality` were registered in migration 021 with no
  template and with input variables from before E06-S01 existed. Every real assessment would have
  failed at the first call. Added in migrations 027 and 028, with the declared inputs corrected.

### Carried forward, deliberately

`advisoryDecided()` is written and unit-tested but wired to no report. E06-S05 acceptance 3 points
at **E07-S06** for enforcement, and building a second surface for it now would mean two places
claiming to answer the same question.

### Deviations from the plan, and why

| # | Plan said | Built instead | Why |
|---|---|---|---|
| D23 | Originality as a rubric dimension | Its own `originality_assessment` table | An advisory dimension must be capable of being omitted entirely. A rubric criterion cannot be — it is part of a frozen standard — whereas a missing row reads as "not scored" and is dropped from the denominator rather than counted as zero. |
| D24 | — | `PRINCIPLES_STANDARDS` blends two sources by a configured split | The dimension can be fed by committee-written rubric criteria *and* by the adopted principles list. The split is explicit and configurable; when either side is empty the other takes the whole dimension, rather than a full-marks submission scoring 50. |
| D25 | — | `PARTIAL` compliance maps to 2, not 3 | Partial compliance with a required standard is nearer the middle than the top. A team should not reach the upper anchors without actually meeting it. |
| D26 | — | Variance is persisted, not recomputed on demand | A dismissed flag must stay answerable months later. Recomputing against a re-normalised cohort could quietly produce a different answer than the one that was dismissed. |
| D27 | E06-S06 "flags cannot be dismissed without a reason" | Enforced by a database CHECK, not a service rule | A service rule is bypassed by the next caller. The constraint ties the dismissal to its reason at the only level that cannot be worked around. |

---

## E07 — Composite scoring and ranking

**Status: complete.** 1026 unit/integration/API/web tests, 45 E2E journeys, 41 containment tests.
Guards, lint, build and typecheck clean.

### What was delivered

**E07-S01 — dimension aggregation.** Built during E06; this epic added the test that the other
four dimensions are **not** normalised within cohort (S02 acceptance 4), which nothing proved.

**E07-S02 / S04 — the ranking is now STORED.** It was computed on read. Both stories say
"stored", and they are right: a ranking re-derived later can hand an appeal a different number
than the one the team was ranked by, and nothing would record which was shown. `submission_composite`
holds the composite, both fidelity figures, both ranks and the caveats; `ranking_snapshot` records
what it was computed from. The cost of storing is staleness, so staleness is made visible —
a ranking built from fewer scores than the run now holds is reported as out of date rather than
served as current.

**E07-S03 — cohort sizes recorded before scoring.** `run_cohort` is written at run start, with
the floor that applied, so retuning the floor cannot rewrite what a past run did.

**E07-S05 — challenge split.** Entirely new: shares, counts, and the median composite per
challenge, with a **non-blocking** advisory above a configured imbalance. The medians are there
to separate two situations that produce the same lopsided table — a stronger field, and a brief
that was easier to score well against.

**E07-S06 — cut-line band.** Stored `in_cut_band`, with the advisory call-out wired at last:
`advisoryDecided()` was written and tested during E06 and deliberately left unattached; it now
flags every submission whose position would move across the line without the originality
dimension.

**Export.** `ranking.csv` carries every caveat in its own column — an export is where a number
is most easily detached from its qualifications.

### What the second review pass found

- **"Flagged for human review" was only ever implied.** E07-S03 acceptance 2 and E07-S06
  acceptance 2 both require it, and a reviewer could only have inferred it from a normalisation
  method in one column and a tie in another. Inference is not a flag. Added `requires_review`
  and `review_reasons` (migration 033), derived by a pure, unit-tested function, with a CHECK
  constraint making the two columns agree. The case this fixes: a submission at rank 40 whose
  cohort was too small to normalise needs a person's eye exactly as much as one at rank 24, and
  nothing said so.
- **Two sources of truth for the same flags.** Variance compared freshly-computed composites
  while the UI showed stored ones. It now compares the stored rankings and refuses when either
  run has not been ranked, so a flag can never describe an ordering nobody saw.
- **The CSV formula guard lived inside a submissions service.** E07's export needed it, and that
  guard must exist exactly once. Moved to `lib/csv.ts`.
- **The cut-band panel derived its own reason wording.** The web app does not depend on the
  scoring package, so it had a second copy of the vocabulary. The API now sends the wording.

### Deviations from the plan, and why

| # | Plan said | Built instead | Why |
|---|---|---|---|
| D28 | Ranking implied as a read | An explicit operation whose result is stored, plus a staleness signal | "Stored" is what both stories ask for, and a position is the thing a team appeals. Recomputation would answer the question differently later without saying so. |
| D29 | — | `GET /ranking` refuses when none has been computed | Inventing one on read would make the endpoint disagree with the stored evidence, which is the failure this epic exists to prevent. |
| D30 | E07-S03 "flagged for human review" | An explicit `requires_review` + reasons, not just the cut band | A too-small cohort is a caveat on a position wherever it sits; scoping review to the band would silently drop those. |
| D31 | E07-S05 imbalance advisory | The advisory states both readings and recommends nothing | Naming an action would be the system deciding, which P0 forbids. It reports the split and the medians and stops. |

---

## E08 — Review and shortlist UI

**Status: complete.** 1158 unit/integration/API/web tests, 60 E2E journeys, 41 containment tests.
Guards, lint, build and typecheck clean.

### What was delivered

**E08-S01 — the ranked table.** Rank, team, challenge, composite, the five-dimension breakdown
and flag counts in one row. Sorting and filtering happen **in the database**; the cut-line band is
visually distinct; every count is a backend count.

**E08-S02 — team detail.** Criteria with anchors, rationales and line-anchored evidence, the
repository link, the build-probe grade with its log link, provenance, and — the piece that
existed nowhere else — **both runs side by side wherever they differ**. Only the criteria that
differ, because listing every criterion twice buries the handful that disagree.

**E08-S03 — flags and guards.** A unified `review_flag` surface materialised at ranking time,
drawing on six modules' worth of evidence: truncated scans, unscoreable criteria, unsupported
stacks, provenance, cohort fallback, run disagreement. Each carries plain-language wording
written beside the condition that raises it, and dismissal requires a recorded reason.

**E08-S04 / S05 — overrides and finalisation.** `SHORTLIST | EXCLUDE | HOLD` with a mandatory
reason, the rank at the time stored alongside, immutability enforced by a **trigger**, and
finalisation refused while any cut-band submission is undecided or on hold.

**E08-S06 — data honesty.** Totals are backend counts throughout; a failed fetch renders
distinctly from an empty result; truncation and partial dimensions are labelled where they show.

### What the second review pass found

- **No way to reach any of it.** Every review screen needed a run id, and nothing in the
  application said what the run ids were. A committee that has to be handed a URL cannot
  "confirm a shortlist quickly", which is the epic's goal. Added a scoring-runs page and a nav
  entry; rows with no ranking say so rather than linking to an empty screen.
- **Sorting was missing** from S01 acceptance 2 — only filtering had been built. Added, with the
  sort key checked against an allow-list rather than interpolated, and unscored dimensions
  sorted LAST regardless of direction: they are not zero, and sorting them to the bottom of an
  ascending list would present them as the worst results.
- **The CSV formula guard needed moving** to `lib/csv.ts` so both exports share one copy.

### The defect worth recording

**`guard:filesize` and ESLint disagreed about the same file.** The guard allowed a test file 500
lines while ESLint held it to 250. Neither number was wrong — they read the same declaration by
opposite rules. `file-size-limits.json` says *first* matching pattern wins, which is how
`limitFor()` reads it; ESLint flat config applies every matching block and lets the *last* one
win. Emitting the rows in declaration order therefore handed ESLint the least specific limit.

Latent since E01, and invisible until a test file was first written under `apps/web/src`. This is
precisely the drift P1.5 clause 6 exists to prevent, so the fix is not only the reversal but
`scripts/limits-agree.test.mjs`, which asserts the two derivations agree on every pattern in the
declaration.

### Deviations from the plan, and why

| # | Plan said | Built instead | Why |
|---|---|---|---|
| D32 | E08-S03 flags surfaced | Materialised at ranking time, not computed on read | These are the caveats the reviewer was shown when they decided. A list re-derived after a re-scan is a different list, and the record would not say which one informed the decision. |
| D33 | — | Flag dismissals survive a re-ranking, keyed by (submission, code) | A reviewer who has answered a caveat should not be asked again because an unrelated submission was re-scored. A caveat that no longer applies disappears, dismissal and all. |
| D34 | E08-S04 immutability | Enforced by a database trigger | A service-level check protects only the callers that remember it, and the next bulk update will not. |
| D35 | — | `HOLD` blocks finalisation | "Looked at and not decided" is a real answer and distinct from no row at all, but it is not a state to lock a shortlist in. |
| D36 | — | A finalised shortlist can be REOPENED, audited with a reason | A shortlist that can never be reopened pushes the real fix into a spreadsheet nobody can appeal against. |

---

## E09 — Governance, evidence and audit

**Status: complete.** 1227 unit/integration/API/web tests, 62 E2E journeys, 41 containment tests.
Guards, lint, build and typecheck clean.

The plan marks this epic "cross-cutting — implement alongside, not after", and most of it was:
the append-only audit log and the role gate have been in place since E01. This pass was an audit
of the claim, and it found four gaps.

### What was delivered

**E09-S01 — audit completeness.** Three actions the plan enumerates were not recorded:

- **Validation outcomes.** Only *regressions* were audited. Whether a submission validated decides
  whether it is scored at all, and a re-check that silently turned PENDING into PRIVATE is exactly
  what a team disputes later.
- **Per-submission commit locks.** The window lock was audited with counts; the commit each team
  was judged on was not. That is the single most disputable fact in intake, and the submission row
  holds only the current value.
- **Score writes.** `criterion_score` is upserted, so a re-score overwrote the previous value with
  no record. Added `scoring.score_replaced`, which captures what was displaced — the only place
  that value survives — plus a per-submission `scoring.submission_scored`.

**E09-S02 — the appeal packet.** New. A self-contained Markdown document carrying the rubric
version and hash, every criterion with its anchors, rationale and quoted evidence, the build
result, provenance, every caveat with its dismissal reason, the recorded decision and its author,
and the audit trail. It explains its own vocabulary, because the reader has no system access and
may be annoyed. Generating one is audited.

**E09-S03 — access control.** Already enforced; now machine-checked. `accessControl.test.ts`
asserts the four privileged acts against the running server for all four roles, and that denials
are audited individually.

**E09-S04 — the publication record.** The rubric was immutable, but the **document** teams
received was re-rendered on every request — so a later change to the renderer would silently
change what "what teams received" means. Added `rubric_publication`: the rendered bytes, a hash
over them, append-only by trigger. Publishing again adds a record rather than replacing one,
because a team may have read either.

### The defect worth recording

**Every export in the application was broken.** Five links — intake CSV, ranking CSV, shortlist
CSV, the probe log and the new appeal packet — were plain `<a href="/api/v1/...">`. This client
authenticates with a bearer token held in JavaScript, not a cookie, so a browser-initiated
navigation carries no credentials: the server answered 401 and the download silently did nothing.

It survived because every test asserted the link's `href` rather than following it. The E2E test
that actually downloaded the appeal packet found it immediately. Fixed with `downloadFile()` and
one `DownloadButton`, and the tests now assert that a file arrives.

### Deviations from the plan, and why

| # | Plan said | Built instead | Why |
|---|---|---|---|
| D37 | E09-S01 "score written" | Per-submission summary, plus `score_replaced` carrying the displaced value | Auditing all ~1000 individual writes per run records volume, not information. The case that loses information is an overwrite, and that is captured in full. |
| D38 | E09-S04 "snapshot stored immutably" | The rendered document bytes, not just the rubric | The rubric was already immutable. Re-rendering on read meant the export could drift from what was published with nothing recording that it had. |
| D39 | — | A publication record is append-only by trigger | A record that can be edited answers "we were not told" with something possibly written afterwards, which is worse than no record: it looks authoritative. |
| D40 | — | Exports fetch with the token rather than navigating | Not a design choice so much as the correction of a defect — but it is why every export is now a button rather than a link. |

---

## E10 — Batch operations

**Status: complete.** 1305 unit/integration/API/web tests, 68 E2E journeys, 41 containment tests.
Guards, lint, build and typecheck clean.

### What was delivered

**E10-S01 — orchestration.** `batchOrchestrator` takes a cohort through scan → probe → score,
stage by stage. Every submission gets a ledger row per stage, and the processing ORDER is
recorded in the run's params — not merely deterministic, but written down, because a resumed or
repeated run is only comparable with the original if both agree what the order was.

**E10-S02 — concurrency.** `mapWithLimit` bounds each stage independently: scanning is disk-bound,
probing is container-bound, scoring is provider-bound, and one limit for all three would be
meaningless. Rate limits now back off **four times harder** than a generic provider error — a
rate limit is the provider saying "slow down", and retrying it on the same ladder as a random 500
means a batch under load spends its attempts racing the limit.

**E10-S03 — cost budget.** A ceiling that PAUSES rather than fails, on actual spend *or* on a
projection crossing it. The projection is the useful half: waiting for actual spend means
stopping after the money is gone.

**E10-S04 — failure isolation and resume.** A failing submission is settled, not thrown; the run
continues and the summary names every failure. Resume skips completed work and is idempotent.

**E10-S05 — progress.** Written to `run_progress`, not only published over the websocket, because
"survives page reload" means a reload has no history to replay.

### The defect worth recording

**`accrueCost` was called by nobody.** The run ledger had a `cost_usd` column, an `accrueCost`
function, and per-call costs recorded on `llm_call_log` with a `run_id` — and nothing summed one
into the other. `run.cost_usd` was zero for every run since E01, which meant the E10-S03 ceiling
**could never have fired**. Rolled up in `callAuditor`, the one place every attempt passes
through, so retries and failures count too.

A second, subtler one followed. Per-submission cost was summed from `criterion_score.cost_usd`,
which records **zero** for a criterion that failed after three paid attempts. A run that retried
heavily looked cheap per submission and expensive overall with no way to reconcile the two. The
acceptance says "from E01-S04 records", so `llm_call_log` now carries a subject, and the two
figures reconcile exactly — asserted with `toBeCloseTo` in the batch tests.

### A flaky test, and why it mattered

`backoff > grows exponentially and is capped` began failing intermittently. Not flakiness: I had
raised the backoff cap for *every* failure class while intending to change only rate limits, and
the test sampled `Math.random()` — so it failed only on runs where the draw exceeded the old cap.
A real regression sat in the suite as noise. The cap is now scale-aware (30s normally, 60s only
when told to slow down) and the test pins `Math.random` instead of sampling it.

### Deviations from the plan, and why

| # | Plan said | Built instead | Why |
|---|---|---|---|
| D41 | — | Stage by stage, not submission by submission | Each stage is bound by something different. Interleaving them would make three separate concurrency limits meaningless. |
| D42 | E10-S03 ceiling | Pauses on the PROJECTION crossing, not only actual spend | Stopping when the money is gone is not a budget control. Pausing on the projection leaves an operator able to raise the ceiling or cut the cohort. |
| D43 | — | `POST /batch/runs` returns 202 with the run id | A cohort run takes hours; a synchronous response would time out at a proxy and the operator would not know whether it was still going. |
| D44 | — | The estimate is null rather than invented | An operator plans around a finish time. A figure derived from one submission is worse than no figure, because they go to bed on it. |
| D45 | — | `llm_call_log` gained a subject | Per-submission cost had no honest source otherwise; score rows under-report by exactly the failed attempts. |

---

## E11 — Calibration and dry run

**Status: complete.** 1408 unit/integration/API/web tests, 75 E2E journeys, 41 containment tests.
Guards, lint, build and typecheck clean.

This epic contains the go/no-go gate, and two of its acceptance criteria are about ORDER OF
EVENTS — which is the one thing a document cannot enforce.

### What was delivered

**E11-S01 — golden set.** Entries spanning strong, middling and weak with all four required edge
cases, hand-ranked independently. Independence is protected rather than requested: a ranker sees
only their own ordering while the set is open, because having seen a colleague's it is no longer
possible to produce an independent one. **Sealing** is what permits machine scoring, and a sealed
set accepts no further entries or rankings — so "before any machine scoring" is a property of
the data rather than a rule somebody remembers.

**E11-S02 — calibration report.** Spearman (not Pearson — the question is order, and nobody
hand-scores a repository 73.4), always with its sample size, every material disagreement listed
individually with the entry's label and expected band, per-ranker correlation so an outlier
ranker is visible, and which dimension least resembles human judgement.

**E11-S03 — the gate.** Criteria are append-only and must predate the report; `generateReport`
refuses without them. The decision is a person's, with a mandatory rationale either way.

**E11-S04 — dry run.** Wall clock, spend, per-stage timings and grouped failure causes from a
completed cohort run, with recommended defaults — and a lead-time check against the configured
evaluation date, because "run at least one week before" is only checkable if the system knows
when the event is.

### The thing that actually matters

**A failed gate now stops ranking.** E11-S03 acceptance 3 says the fallback is fully human
judging and the system may then be used "for evidence gathering only, not for ranking". That is
a behaviour, not a paragraph — so `computeRanking` calls `assertRankingPermitted`, and a NO_GO
(or no decision at all) refuses with the recorded fallback plan quoted back.

**No decision is treated as NO_GO.** An uncalibrated system being usable by default is the exact
failure this story exists to prevent, so silence is not a pass.

The bypass flag ships **ON**, and that deserves stating plainly rather than burying: development,
rehearsal and the calibration run itself all need to rank before any gate decision exists.
Shipping it OFF would mean everything began by failing and the first thing anybody did was turn
it on and forget. It is logged as a warning on every ranking performed while it is on, and
turning it off belongs on the pre-event checklist.

### What the second review found

- **The seal trigger made a sealed set unusable.** Sealing is what permits scoring, and the
  trigger refused the one write that necessarily follows — recording which submission each entry
  was scored as. Narrowed to permit only that column, and nothing else on the row.
- **The trigger then broke on the other table.** The exception was guarded by
  `TG_TABLE_NAME = 'golden_entry'` in the same expression as `NEW.label`; PL/pgSQL resolves
  record fields at runtime rather than short-circuiting, so a refusal on `golden_ranking` came
  back as `record "new" has no field "label"` — a rule presenting itself as a bug. One function
  per table; the shared one was false economy.
- **The gate status only appeared on one of the two pages that show rankings.** Added to both.
- **A test-isolation hazard I had just created:** the gate seed turns the bypass flag off and
  nothing turned it back on, so a spec running afterwards would inherit a gate it never asked
  for. The scoring seed now restores it.

### Deviations from the plan, and why

| # | Plan said | Built instead | Why |
|---|---|---|---|
| D46 | E11-S01 "before any machine scoring" | A SEAL that permits scoring and freezes judgement | The failure is drift, not dishonesty: a hand ranking adjusted once the machine's answer is known. Nobody decides to do that; it happens. |
| D47 | — | One ranker cannot see another's ordering while open | Independence cannot be restored once lost, so it is protected rather than asked for. |
| D48 | E11-S02 "rank correlation" | Null, with a reason, rather than a meaningless number | ρ over two items is always ±1. A coefficient that cannot mean anything must not be reported as though it could. |
| D49 | E11-S03 gate | `assess()` returns a *suggestion*, never a decision | A function returning "the decision" would be the machine deciding whether the machine is fit to decide. |
| D50 | — | The bypass flag defaults ON, and says so loudly | Shipping it off would make every rehearsal start by failing, and it would be switched on once and forgotten. This puts the choice in front of a person when it matters. |

---

## Audit pass — the whole plan re-reviewed

A second reading of `CRUCIBLE_EPICS_AND_STORIES.md` end to end, including the parts outside the
epics: Part I's findings, Part II's data model and rubric contract, the risk register, the open
decisions, and **§IV.5, the system-level definition of done**. Checked against the code rather
than against the build log.

Most of it held. The data model matches (`rubric.status` carries all five states,
`submission.artifact_urls` exists, every table in §II.2 has an implementation), the rubric
contract's invariants are enforced, and every story's acceptance criteria trace to tests. Two
things did not.

### Gap 1 — §IV.5.6 was not enforced

*"Every flag in the cut band was reviewed by a person and the review recorded."*

Finalisation blocked on a missing or held **decision**, but not on an unanswered **caveat**. A
shortlist could be locked with every cut-band submission decided and every flag on them
unreviewed — which is exactly the unexamined acceptance the flag surface exists to prevent.

The telling detail: `submissionsWithOpenFlagsInBand` existed, was written for precisely this, and
was **never called**. Written and forgotten in the same epic.

Now blocked, with the three states distinguished in the refusal — undecided, held, and decided
but still carrying an unanswered caveat — because they need different actions.

### Gap 2 — §IV.5 had no implementation at all

Seven statements the plan says must hold before this system decides anything, and nothing checked
any of them. They read as a checklist for a person, and a checklist a person keeps on the night,
under time pressure, is a checklist that is partly kept.

`readinessReport` now evaluates all seven against the database and reports **what it found**
rather than pass or fail: "of 50 submissions: 2 never probed" tells an operator what to do;
"incomplete" does not. `UNKNOWN` is kept distinct from `FAIL` and does not count as ready — a
check that could not be evaluated is not a check that passed.

### Also found

- **Three dead exports** (`submissionsWithOpenFlagsInBand`, `openFlagCounts`,
  `selectPublication`). The first was Gap 1; the others removed.
- **Cross-file E2E coupling I had introduced myself.** `seedGateDecision` records a gate decision
  and turns the bypass flag off; nothing restored either, so a spec running afterwards inherited
  a gate it never asked for. The scoring seed now resets the whole calibration state, not just
  the flag — the same mistake I had already fixed once for the flag alone.

### Verification

1435 unit/integration/API/web tests, 78 E2E journeys, 41 containment tests. Guards, lint, build
and typecheck clean.

---

## E12 — Repository discovery and the catalogue

Crucible could score a submission but could not say what one *was*. A reviewer opened a team's
page, saw numbers and excerpts, and had to read the repository themselves to answer "what did
they actually build?". Discovery closes that, and — per the corrected ADR 0003 — feeds what it
finds back into the evaluation rather than sitting beside it.

### The shape: seven concerns, not one prompt

The reference implementation asks a single prompt to return eleven shapes at once. When any
fragment of that JSON is malformed the whole scan is lost, and a repository whose endpoints
extracted perfectly still shows nothing.

Here each concern is its own registered call key with its own prompt, schema and config. A failed
extractor costs that concern, is recorded as `FAILED`, and the other six stand. The integration
test asserts exactly that: kill the security call, and endpoints and entities are still `FOUND`
and the run still `COMPLETED`.

Each concern selects its own evidence through the **one** context builder (P1.5), driven by an
evidence specification in the same form a criterion uses. No second ranking implementation to
drift from the first.

### The rule the whole feature turns on

**A gap is never a zero.** On a dashboard "0 integrations" and "we could not read the
integrations" look identical and mean opposite things — one says the team built something
self-contained, the other says we failed to look. A reviewer who cannot tell them apart will
read the second as the first and mark a team down for our failure.

So a tile shows a number only for `FOUND` and `NONE_FOUND`. Otherwise it shows the state in
words plus, in as many words, "not a zero". Unreadable concerns are also named at the top of the
page with the reason and the sentence "nothing is scored down for them".

`NONE_FOUND` is the subtle half. Zero is a legitimate answer for some concerns and not others:
an application really can integrate with nothing, but one with no data model, no endpoints and
no stack has almost always been shown the wrong files. Each concern declares which it is, and a
zero where zero is implausible is recorded as `INSUFFICIENT_EVIDENCE` rather than displayed as a
fact about a team's work.

### Security observations, not vulnerabilities

Crucible has no CVE database, cannot resolve dependency versions, and sees only the files a
budget let it read. The field is therefore `concern`, not `severity` — severity is a property of
a confirmed vulnerability, and nothing here is confirmed. The schema has no severity field at
all, which is what makes the distinction survive contact with a future edit.

Every observation must carry `benign_explanation`: what a reviewer should check that would rule
it out. An observation without one reads as an accusation, and accusing a team of a flaw they do
not have is the worst thing this feature could do.

The same reasoning governs claim conflicts, harder. Teams write documentation before they write
code, over a weekend, under time pressure; a gap between the two is ordinary. Silence is
explicitly excluded as a conflict — absence of evidence fails the test — and the innocent
explanation is concatenated into the observed text **on the server**, so there is no render path
that can show the accusation without the caveat.

### Defects found and fixed

**`uq_discovery_current` rejected every second discovery.** `openDiscovery` inserted the new run
and superseded the old one afterwards. The index is a plain partial unique index, not a deferred
constraint, so it fires the moment two rows have `superseded_at IS NULL`. Every submission could
be discovered exactly once. The old run now stands down first.

**Migration 054 failed the same way** for the same reason, one layer up: it inserted v2 of the
scoring prompts before deactivating v1, and `uq_prompt_active` refused it.

**Seven registered call keys with no prompt templates.** Migration 048 registered the keys and
shipped no `llm_prompt_template` rows — the identical defect migration 027 had to repair for the
principles evaluators, where a registered key with no active template fails at prompt
resolution, on the first real run, in production. Four migrations now carry the prompts.

**`pnpm guard` did not run the file-size guard.** CI ran `node scripts/guard-filesize.mjs`
directly, so `pnpm verify` passed locally on a violation CI would reject. Wired in as
`guard:filesize`, and CI now calls the same script name.

**The catalogue form could submit a draft the API would refuse.** No client-side check on
`pillar`/`category`, so an unchosen one produced "the request body did not match the expected
shape" — a message naming no field. Found by the E2E, which is where it should be found.

### Authoring, and the two acts that must stay separate

Principles and standards are now written in the application. Two rules are visible in the UI
because both are load-bearing:

- **Authoring is not adoption.** A new entry is created inactive. Writing a principle down must
  not silently change what every team is being scored against.
- **Retire, do not delete.** An entry already assessed against is withdrawn, not removed — a
  score taken under it must stay explainable.

Two client-side checks earn their place: an evidence specification specific enough to select
source by, and five anchors that actually differ. Identical anchors give a model no way to
choose between levels, so it picks the middle one and the maturity scale quietly stops meaning
anything.

### The surfaces that were API-only

A challenge could only be created with curl, and a team could only submit with one. Both now
have pages. The challenges page states the order the work happens in — brief, extraction, then
rubric — and disables rubric generation until at least one document's text has been extracted,
because a rubric drawn from an unread brief cites passages nobody can open and looks entirely
normal until someone follows a citation.

The submission page is public by design (P8.2). It needed one new allow-listed route,
`GET /api/v1/challenges/open`: a team has to say which challenge they are entering and has no
account with which to read the list. Scoped to OPEN challenges, id and name only. P8.1 in the
principles doc and the pinned allow-list test were both updated — that test exists precisely so
widening the list cannot be silent.

### Not done, and stated

The ADR commits to pinning the discovery flag per scoring run so two runs are not silently
compared across different evidence bases. It is not built, and the reason is bigger than
discovery: **no run in the system records the feature flags it executed under.** That is a P4.4
gap discovery made visible rather than one it introduced. Recorded in ADR 0003 under "As built".

### Two prerequisites that had no UI at all

Found by a question — "how does a team submit?" — rather than by a test, which is its own
lesson: the submission page I had just built was unreachable in practice, because nothing in the
application could produce the two things it depends on.

**No window, no submissions.** Intake refuses every team until a window exists, and dev sat at
`NO_WINDOW` throughout. The Intake page now sets the dates. "No window" is stated as its
consequence — *no team can submit* — rather than as an empty field, because that is the sentence
an organiser needs at 11pm.

Locking is kept separate from closing and made deliberately harder. A closed window reopens by
moving its dates; a locked one does not reopen at all. That is the point of locking, so the
confirmation names what it costs, including the team whose repository turned out to be private.

**No token, no team.** Teams authenticate with a scoped token and have no account by design
(P8.2), and minting one was curl-only. The Intake page now issues, lists and revokes them. Two
details earn their place: the plaintext is shown exactly once with a statement that it cannot be
recovered (only the SHA-256 is stored), and a token that has **never been used** is flagged —
before a deadline that usually means it never reached the team, and afterwards nothing can be
done about it.

### The rubric was three clicks deep, and frozen was a dead end

Also found by a question: "how do I go to the rubrics page?" There was no answer that did not
involve knowing the URL. Worse, on arriving at the only rubric — frozen — the page said *"create
a new version to change it"* and offered no way to do so. A dead end of exactly the kind P5.4
forbids, and one I had walked past while building the weight editor.

`POST /challenges/:id/rubrics` now takes `copyFrom`, carrying the source version's criteria and
dimension weights into the new draft, and the frozen page has the button. An empty draft would
mean retyping seven criteria to adjust one weight — which turns a correction into a rewrite, and
a rewritten rubric is not comparable with the one teams were shown.

The gate's `needsRewrite` verdict is deliberately **not** copied. It says the gate could not
confirm *that* wording was scoreable; the new wording has not been gated, and inheriting the flag
would either excuse a fresh problem or condemn a fixed one.

The Challenges list now carries a rubric column resolving to the published version if there is
one, else frozen, else newest draft. Teams are judged by what was published, so that is what a
link labelled "rubric" has to mean.

### Three defects my own changes caused

All three surfaced only in the full E2E suite, and all three are the kind that hide in a
single-spec run.

**A duplicate live region.** The window panel announced intake state with `role="status"` — which
the page header already did. A screen reader would read it twice. The panel now shows the
window's dates and consequences, which the header does not give, and announces nothing.

**A positional test locator.** `intake.spec` addressed its target as `getByRole('table').last()`.
Adding a tokens table below made "last" the wrong table. Fixed at the source rather than the
symptom: all three intake tables now carry an `aria-label`, and the test names the one it means.
A table with no accessible name was a P5.5 gap regardless.

**A network-dependent timeout.** Submitting performs a real repository reachability check, so the
receipt assertion waits on a network round-trip that has nothing to do with the UI. Seven seconds
sufficed when the spec ran alone and not under full-suite load — the shape of a flake, not a
product defect. Raised, with the reason recorded next to it.

And one defect in code written an hour earlier in the same session: the submit page's client type
flattened `{ state, window, message }` into `{ state, opensAt, closesAt }`, so the "entries close"
line never rendered. Mirroring the server's shape exactly is the fix; guessing at it was the bug.

### Seeing discovery without a provider key

A development machine has no provider key, so running discovery there fails all seven concerns
and leaves a page with nothing on it. `pnpm db:seed:discovery` writes findings directly — and the
file says plainly that it does, rather than implying it drove the pipeline the way
`db:seed:cohort` genuinely does.

What the fixture preserves is the mix that matters: one concern genuinely empty, one that could
not be read, and the rest found. Those three render as a count, a real zero and a stated gap, and
a fixture where everything succeeded would make the distinction invisible on exactly the screens
built to show it. On dev it produces `Integrations 0`, `Stack — Not determined`, and `warn` on
security and claim conflicts only.

### Verification

`pnpm verify` clean: **1675 tests across 95 files** (unit, integration, API, web and the
containment suite), plus guards, lint, build and typecheck. **119 E2E journeys** pass.

Against the 1435 tests and 78 journeys standing before this epic, that is 240 new tests and 41
new journeys — covering discovery's seven concerns, the four-state outcome vocabulary, the tile
strip's refusal to print a zero for a gap, the digest passed to the evaluators, catalogue
authoring, challenge setup, the public team submission, issuing tokens, opening intake, and
copying a frozen rubric forward into a new version.

---

## E13 — Evidence integrity

The gap register's only Critical item. Every score and every discovery finding carried a path, a
line range and an excerpt; the schema enforced that those fields were **present**, and nothing
enforced that they were **true**. A model could cite `src/auth/session.ts:42–58` with a plausible
invented excerpt and Crucible would store it, render it to a reviewer, and reproduce it verbatim
in the team's appeal packet.

P4.1 had asked for this all along. It names three validations before an output may be stored —
schema, content, and **semantic**, "output satisfies quality criteria for its type (e.g. a
criterion score carries at least one evidence reference with a path and a line range)". Only the
first two were enforced. This was not a missing feature so much as an unkept promise.

### Where it went

The verifier is a pure function in `@crucible/scoring`, used by scoring and discovery alike — one
implementation, two callers (P1.5). The scan is already persisted in full, so checking a citation
is a lookup, not a model call.

Three verdicts, and keeping them apart is the whole design:

- `VERIFIED` — the file is in the scan, the range is inside it, the quoted text is there.
- `UNVERIFIABLE` — the file, or the cited part of it, is not among what the scan read.
- `CONTRADICTED` — the scan covers this, and the citation does not hold.

Collapsing the last two would either excuse fabrication or punish a file budget that ran out.

The check runs in `attemptRunner`, beside schema validation, because P4.1 names all three
together. Putting it in the orchestration loop instead — where it first went — made it look
optional, and it is not.

### Four defects found by writing the tests

**An ellipsis is not a deletion.** The first implementation stripped `...` and compared the
remainder, which demands the two halves be adjacent — the opposite of what a trimmed quote means.
Now segments are matched **in order**, which also closes a hole the naive version had: without
ordering, a model could stitch fragments from unrelated parts of a file and pass.

**A model could evade checking entirely.** An absent path was always `UNVERIFIABLE`, so citing
only files outside the scan would defeat the whole feature. The scan records whether it was
truncated, and that settles it: if the scan read the entire repository, a path it does not hold
is a path that **does not exist**, and that is `CONTRADICTED`.

**Verdicts were recorded for criteria and not for principles or standards.** Caught by an
existing test asserting all three produce evidence in the same shape — which is exactly what that
test is for. One shared mapper now, rather than three copies to drift.

**A line break landed mid-sentence** in the appeal packet, splitting "That is a / limit of our
reading". Found by the E2E, which reads the real downloaded document.

### A fixture that was lying

Updating the discovery fixture was the moment the feature proved itself. Its findings cited
`'source line'` as the excerpt for every location — a placeholder that matched nothing. With
verification on, all of them were correctly dropped and the concern reported `FAILED`.

The fixture now derives each excerpt **from the source it cites**, looked up by line number, so
it cannot drift from the repository it describes. A hand-written excerpt would fail later as a
product defect rather than as the fixture error it is.

### What a reviewer and a team now see

A reviewer sees, beside each quotation, either *checked against the source* or *outside what the
scan read* — in words, never colour alone (P5.5), with the detail on hover. A score taken before
checking existed claims nothing rather than implying a check happened.

The appeal packet gained the most from this. It now says how many citations were found in the
commit the team submitted, which turns "here is a quote" into "here is a quote we checked against
your commit" — a materially stronger thing to defend a decision with. Where a quotation could not
be checked it says so as *a limit of our reading, not a doubt about your work*, and no verdict
code a reader would have to look up appears anywhere in it.

### Verification

`pnpm verify` clean: **1731 tests across 98 files**, plus **124 E2E journeys**. Of those, 31 unit
tests cover the verifier directly and 14 integration tests drive a provider that returns
well-formed, schema-valid responses citing source that does not exist — the containment suite's
idea, aimed at the model rather than at the code.

---

## E14 — Runs that mean something

`run.pinned_config` has existed since migration 004, carrying a comment that states the
commitment outright: *"P4.4: the model is pinned per run; a config change must not affect an
in-flight run."* It held four keys — concurrency limits and cost ceilings — no feature flags at
all, and **nothing read it back**. The scoring path resolved every value live, so a setting
changed at 2am genuinely did reshape the second half of a cohort. The pin was a record of intent.

### The conflict that had to be resolved first

Taken literally, P4.4 contradicts E10-S03. One says configuration must not affect a run in
flight; the other expects an operator who raises a cost ceiling to **resume** rather than
restart. This system's own caching note sides with the second: a raised ceiling "needs to take
effect now, not within a minute".

Both are right, about different things. A ceiling or a concurrency limit decides whether and how
fast a run finishes; it does not decide what anything scores. A context budget, a cut line, a
model assignment or a probe timeout decides the outcome itself.

So the distinction is **declared**, not hand-listed in code: `app_config.affects_outcome`. Thirty
of forty-nine settings decide an outcome. Every feature flag does, without exception — discovery
being on for half a cohort is the case that motivates it. A hand-listed set would silently stop
covering settings added later, which is the failure the test-database reset already had to be
fixed for once.

### Making the pin real

The mechanism is an AsyncLocalStorage scope, for the same reason the correlation id is one: a pin
threaded through signatures by hand gets dropped at the first refactor, silently, in the services
where silence matters most.

It resolves in `configService.load` — the single point every read already passes through — so
**every existing call site became pinned without one of them changing**, and none of them can
forget.

The strictness is the load-bearing part. Inside a run, reading an outcome setting the pin does
not carry is an **error**, never a quiet fall-through to the live value. A fall-through would
reintroduce the bug for precisely the settings nobody remembered to include, which is the
population most likely to contain the next one. `withoutRunPin` exists for the handful of reads
that must be live, and is explicit so that using it is a decision rather than an accident.

### Drift, where it is read

The variance comparison now answers "were these two runs even alike?" before it compares
anything. A variance flag reads as model instability; if the settings moved between the runs it
is measuring the settings, and a reviewer who does not know that will read it wrongly.

The gate got the same treatment, and it needed a third state rather than a second. A verdict
whose configuration has demonstrably moved is loud. A verdict taken **before configuration was
recorded** is quiet — we do not know what it was measured under, which is a different fact from
knowing it has changed. Collapsing them would either cry wolf on every historical decision or
claim a coverage we cannot support. The E2E caught exactly this: its seeded decision has no pin,
and the banner was calling that "settings have changed".

### `reviewer_model` was named for a pass that does not exist

Renamed to `fallback_model`, which is what it is: the model the retry ladder switches to after an
empty response. The old name implied that scores are reviewed by a second, stronger model.

**This does not close the underlying gap, and the migration says so.** P4.3 requires
Worker/Reviewer/Judge for every CRITICAL artifact and names six call keys. Only
`rubrics.criteria_generate` has it; `scoring.criterion`, `scoring.engineering`,
`scoring.principles` and `scoring.standards` have no reviewer at all — and P4.3 explicitly
pre-empts the obvious defence, noting that the double run "is a separate and additional control…
neither substitutes for the other." Closing it triples the cost of the dominant spend, so it is
recorded as an open decision rather than settled silently in a rename.

### Two defects found while testing

**An empty pin crashed the comparison.** Every row written before pinning existed carries `{}`
from the column default — the ordinary case in any deployment that has run before, not an edge
case. It now counts as *no pin*, which is honestly different from *the same pin*.

**The suite had a real flake, not a coincidence.** "Deadlock detected" appeared twice across the
session. The `integration` and `api` projects each run in a single fork, but as separate
processes against one database, so two resets could truncate the same tables at once. Serialised
with a `pg_advisory_xact_lock`; retrying the deadlock would only have made it rarer. Two
consecutive clean runs confirmed it.

### Verification

`pnpm verify` clean: **1764 tests across 100 files**, plus **124 E2E journeys**. Seventeen unit
tests cover the pin and the comparison; twelve integration tests prove a live configuration
change is invisible to a run in flight, that a flag cannot be switched mid-cohort, that
operational knobs still come through, and that an unpinned outcome setting is refused rather than
read live.

---

## E15 — Discovery at cohort scale

Discovery made seven sequential model calls inside one HTTP request — up to twenty minutes
against a thirty-second platform timeout — and opened no ledger run at all. Three consequences
followed from that single omission, and only the third really matters.

No progress and no resume: a dropped connection lost the visibility even though the work
continued, so an operator could not tell a hung run from a finished one. Spend outside every
ceiling, because a ceiling is enforced against a run. And — the one that is a fairness problem
rather than an ergonomics one — it could not be a batch stage, so a fifty-team cohort needed
fifty manual triggers, and any that were missed produced submissions scored on **less context
than their competitors**, against the same rubric, in the same ranking, silently.

### Discovery is a run

It opens a ledger run of its own when nobody supplies one, and records against the batch's when
one does. Each concern is a `stage()` call, so progress is **persisted as well as published** —
a websocket message is gone on reload, which is exactly when somebody checks on a long run. A
resumed run skips concerns it already completed.

Because it now has a run, its spend accrues to one, which is what brings it under a ceiling.

### A bug caught before it could be written

Concern records are keyed `${submissionId}:${concern}`. Inside a batch the ledger run is shared
by the whole cohort, so an unqualified concern key would have let the second submission skip
`endpoints` because the first had already done it — **every submission after the first would
have come back nearly empty**, and the resume logic that caused it would have looked like a
discovery failure.

### Discovery is a batch stage, before scoring

`STAGES` is now `scan → probe → discovery → score`. The order is the point: scoring reads what
discovery produces, so running it afterwards would leave every submission scored without the
context discovery exists to supply.

Opt-in per batch and off by default, preserving the cost decision the feature flag exists to
make. A batch that asks for discovery while the feature is disabled is refused **up front**
rather than failing the stage fifty separate times — fifty identical failures saying the same
thing make a run look like fifty broken repositories rather than one setting.

### The fairness half

`coverageFor` answers the question that actually matters, which is not "how many were described"
but **"were they all treated alike"**. Three states, and only one is a warning:

- **NONE** — nobody was described. Consistent, therefore fair. Silent.
- **COMPLETE** — everybody was. Silent.
- **PARTIAL** — some were and some were not. This is the unfair one, and it is loud.

Warning on the first two would train a reviewer to scroll past the warning that matters. The
banner names how many were judged on less context than their competitors and says what to do
about it, because a warning with no action is one a reviewer learns to ignore.

### Three defects found while building it

**A P1.3 violation in my own work.** The coverage query joined `criterion_score` from inside the
discovery module — a cross-module table read that works today and breaks the moment scoring
reshapes a table it owns. The ranking module now supplies the submission ids; discovery answers
only about its own tables.

**A paused run was being closed as SUCCEEDED.** The ceiling paused the ledger run and then the
happy path closed it, erasing the one fact an operator needs: that there is work left to resume.

**Concerns the run never reached vanished.** An absent concern renders as "could not read", which
says we tried. We did not. They are now recorded explicitly as *not attempted: the run stopped at
its cost ceiling before reaching this concern*.

And one in the UI: `STAGE_LABEL` had no entry for the new stage, so a batch would have shown the
raw key `discovery` to an operator.

### A test that priced the wrong thing

The ceiling test priced the model by the fake provider's name. The gateway resolves the model
from `llm_call_config` — the provider is only the transport — so every call was costing zero and
a ceiling over zero could never be reached.

### Verification

`pnpm verify` clean: **1794 tests across 101 files**, plus **128 E2E journeys**. Fourteen
integration tests cover the run, the per-submission concern scoping, resume, the pausing ceiling
and coverage; four E2E journeys cover the reviewer seeing — and correctly not seeing — the
unevenness warning.

---

## E16 — Discovery as governed evidence

Discovery was reachable from exactly one place: a link on one team's review page. It did not
appear in the appeal packet, the readiness report, or anywhere a decision is defended from. And
a reviewer who checked a security observation and found it benign had nowhere to record that.

### The packet was missing part of its own basis

The appeal packet is the strongest commitment this system makes — a self-contained document
answering "why did we not present?" without system access. Discovery informs the principles and
standards evaluators, so a team disputing a principles score could not see the map the evaluator
was given. **The packet omitted part of the basis for the scores it reported.**

It now carries the digest, labelled as CONTEXT rather than evidence, in the same terms the prompt
uses — so it cannot imply a finding carried more weight than it did. Where no pass informed the
run it says so plainly rather than omitting the section, because an omission reads as "there was
nothing".

### An eighth readiness check

The definition of done covered the scores without covering what they were made from. Discovery
coverage is now §IV.5.8, and it reports what it found rather than pass or fail, in the form the
other seven use. Only PARTIAL fails: a cohort nobody discovered is consistent, and therefore
fair.

### Checking an observation

Every security observation ships with a `benign_explanation` naming what a reviewer should check
to rule it out. That is the point of the field — and when the reviewer checked it and it WAS
benign, there was nowhere to say so. The observation stayed amber and the next reviewer repeated
the work.

Worse than the wasted effort: **a checked observation and an unexamined one looked identical**,
which is precisely the confusion the tile design works hardest to avoid everywhere else.

Three rules shape the fix, and each mirrors something the system already does:

- The reason is **mandatory and enforced by the table**, matching `review_flag` — a service check
  is one the next caller can route around.
- A dismissal **supersedes rather than deletes**, matching discovery runs themselves — an
  observation that vanished would leave a decision taken while it was on screen unexplainable.
- The observation **stays visible and marked**, dimmed rather than hidden. Hiding it would be the
  same confusion in the other direction: a reader could not tell "we looked and it was fine" from
  "we never mentioned it".

The tile's warning now tracks what is still OPEN rather than what was found. The **count does not
change** — a reviewer checking an observation does not make it stop having existed — but the
amber does, because there is nothing left to look at.

### What the evaluators are told about a checked observation

A dismissed observation is **marked in the digest, not dropped**. Dropping it would hide that
anyone looked; leaving it unmarked would feed an evaluator something a person has already
determined is benign, and let it weigh against the team a second time. It now arrives as
`CHECKED BY A REVIEWER AND SET ASIDE … do not weigh this against the submission`.

### What changed since the last discovery

A deterministic match on `(kind, label, path)` — no model call. The reference implementation
spends a call classifying NEW/UPDATE/DUPLICATE; a join answers the same question for nothing.

The wording carries the caveat that makes it honest: a finding that is no longer reported **may
have been fixed, or may simply not have been read this time**, and the two are indistinguishable
from here. Presenting "gone" as "resolved" would invent a conclusion the evidence does not
support. Computed on demand, because most discoveries are never compared.

### Two defects found while testing

**The tile kept warning after everything had been checked.** `open[kind] ?? live` falls back to
the full count when a kind is absent from the open counts — and a kind is absent precisely when
every one of its findings has been checked, which is the exact case that should stop warning.

**The tile's warn state was colour alone.** The amber border said "look at this" to a sighted
reader and to nobody else. It now carries a screen-reader-only "needs a look" (P5.5), which also
made the E2E assertion honest rather than inferential.

And one over-clever test of my own: it asserted the absence of the word "fixed" in the diff note,
which the honest sentence legitimately contains inside its caveat. Testing for an absent word was
the wrong shape; the hedge itself is the property.

### The test suite was sharing one database, and I made it worse before I made it better

E14 fixed a TRUNCATE deadlock between the `integration` and `api` projects with an advisory lock
around the truncate. That was a half-locked critical section, and this epic's longer suite
exposed the rest of it: the two processes truncated in turn and then **restored the declared rows
at the same time**, producing "that record already exists" in a completely unrelated test.

Widening the lock to cover the restore fixed the race and introduced a worse problem. Every reset
in both projects then queued behind a migration replay, and the suite went from about two minutes
to **520 seconds**, timing hooks out. A correct fix that makes the suite unusable is not a fix.

The actual answer is not to sequence the contention but to remove it: **one database per test
project**. `api` runs against `crucible_test_api`, created on demand, and nothing is shared, so
there is nothing to serialise. Back to ~175 seconds, and two consecutive clean runs.

### Verification

`pnpm verify` clean: **1826 tests across 105 files**, twice in a row, plus **133 E2E journeys**.
Twelve integration tests cover dismissal, reinstatement, the database-enforced reason, the tile's
warning, the digest marking and the diff; five E2E journeys follow a reviewer checking an
observation and seeing it stay visible.

---

## E19 — Operator readiness

Three small things, all of which failed the same way: silently.

Two configuration values shipped unset and disabled what depended on them with no sign anywhere.
Without `event.evaluation_date` the dry run could not be shown to have happened early enough;
without `scans.event_window` provenance could not flag work committed outside it, and the 40%
threshold sitting beside it had nothing to apply to. And `GET /scans/provenance/flagged` had
existed since E04-S06, returning exactly what an operator needs — with nothing in the application
calling it.

### Unset is UNKNOWN, not FAIL

The readiness report gained a ninth check, and its status is the point. Nothing has gone wrong
and nothing has been decided, which is exactly what `UNKNOWN` is for — but `UNKNOWN` still does
not count as ready, so it cannot be ignored either. It names the specific settings and what each
one costs, because a general complaint is not actionable.

### A surface that states consequences, not names

Each field on the event setup panel says what it is *for*: the evaluation date carries the
lead-time requirement, the event window carries the sentence that matters most — commits outside
it are **flagged for a person to look at, never excluded and never acted on automatically**. A
setting whose effect is invisible is one nobody sets.

### A queue that can be worked

Flagged histories are now a list, unresolved first. Resolving one records what a person concluded
— with the reason enforced by the table, matching `review_flag` and `discovery_dismissal`, at the
level the next caller cannot route around.

Three details carry E04-S06's framing rather than restating it:

- A resolved entry **stays in the list**, marked. "Somebody looked and was satisfied" must be
  distinguishable from "nobody has looked yet".
- There is **no control that excludes a submission**, and the page says so where a person is
  about to act.
- An empty queue says it may mean *nothing is configured* rather than *all clear* — otherwise the
  unset event window reads as a clean bill of health.

The appeal packet gained the conclusion too. Reporting a flag without saying whether anyone
answered it would leave a team reading a suspicion nobody ever resolved.

### A regression I caused, and why the types did not catch it

Widening `provenanceFor` to carry the resolution changed its return from an array to an object.
`teamDetail` passed it straight through, the web tried to `.map` it, and **fourteen E2E tests
failed on a page that had nothing to do with provenance**.

TypeScript was silent because the web declares `TeamDetail` **separately, by hand** — nothing at
compile time links the API's response shape to the client's expectation of it. That is a
structural gap wider than this epic: the two declarations can drift at any point on the boundary,
and only a test will say so. The API contract test now asserts the shape explicitly, with the
reason recorded next to it, but the general problem is worth a shared contract type and is not
solved here.

### A test pattern that broke three times

Three separate suites hard-coded the number of readiness checks, and every epic that added one
broke all three. They now assert the plan's seven **by id**, which is the actual property —
"every statement is reported" — and says something a count never did: that the right ones are
there.

### Verification

`pnpm verify` clean: **1853 tests across 107 files**, plus **140 E2E journeys**, with the suite
back to about a minute after E16's database split. Thirteen integration tests cover the readiness
check and the queue; fourteen web tests and seven E2E journeys cover the two surfaces.

---

## E18 — The committee's workbench

Two of the most consequential things this system asks a person to do existed as API endpoints and
nowhere else. Rewriting a criterion the quality gate flagged, and assembling the evidence the
go/no-go gate rests on, were both reachable only with a terminal and a bearer token — which in
practice means the committee does not do them.

### Rewriting a criterion where the gate flagged it

The quality gate already says which criteria it could not confirm were scoreable, and why. Until
now the answer to "so fix it" was to produce a whole new rubric version by hand. The rubric page
now opens an editor on the flagged criterion itself, with its five anchors in it.

Two constraints came straight from the existing rules rather than being invented here:

- **Only a DRAFT rubric offers the editor.** A frozen rubric is immutable at the database level
  (P7.1), so a form that appeared to edit one would be a lie the trigger would catch later. The
  page offers "create a new version from this one" instead, which is the real path.
- **The same two checks the authoring form applies** — an evidence specification of at least 20
  characters, and five *distinct* anchors — run in `criterionProblems` before the save, so a
  committee member finds out while they are still holding the wording, not after a round trip.

### The gate, assembled in one place

`/calibration` now holds the whole sequence in the order the server enforces it: build a golden
set, have people rank it by hand, record the gate criteria, produce the report, record the
decision. Nothing about that ordering is new — the API already refused a report without a sealed
set, refused a seal below two rankers, and refused a report with no criteria recorded. The page
simply stops it being discoverable only by hitting the refusals.

Three decisions in the ranking view are worth stating:

- It shows **who has ranked, never how**. A second ranker who can see the first ranking is not an
  independent ranker, and the whole value of the hand ranking is its independence.
- A partial ranking is **refused rather than padded**. Ranking six of ten and leaving four blank
  produces a correlation that means nothing, and silently filling the blanks would hide that.
- Readiness comes from the **server's own `readiness.problems`**, rendered as given. Recomputing
  it in the browser would produce a second definition of "ready" that drifts from the one that
  actually gates the seal.

### Two gaps the second review round found

The ranker identity was hard-coded to `'me'` while I was wiring the form up. Left in, it would
have made every ranking in the system attributable to the same non-existent person — precisely
defeating the independence the ranking exists to establish. It now comes from the session.

And the page recorded gate criteria, sealed sets and decisions, but never *produced the report* —
the step that turns all of it into a verdict. The sequence was one component short of being a
sequence.

### A response shape I got wrong

`getGateCriteria` returned `{ current, history }` from the route and the client expected the
criteria object directly, so the form rendered empty against criteria that existed. The same
class of drift as E19's `TeamDetail` regression, and the same root cause: the client declares the
response shape by hand. Unwrapped at the client; the structural fix is still a shared contract
type and is still not built.

### Verification

`pnpm verify` clean: **1873 tests across 108 files**, plus **148 E2E journeys**. Twenty web
component tests cover the editor's refusals, the readiness rendering and the ranking's
independence; eight E2E journeys walk the two surfaces in a browser, including the frozen-rubric
case where the editor must *not* appear.

---

## E17 — Team identity

A team was `submission.team_name TEXT`, unique per challenge among current entries. Three things
followed, and all three are defects:

- "Night Shift" and "The Night Shift" were different teams and **neither knew it**.
- A team that corrected its spelling between versions started a second lineage, because the key
  it was matched on changed. They ended the evening with two entries and neither superseded.
- A token was labelled with a name nothing ever reconciled against the form, so the audit trail
  could not answer *did this team submit with their own token?* — the question a disputed entry
  turns on.

Sequenced last on purpose. It is the only epic that rewrites how an existing entity is identified,
on tables that already hold data.

### The token is the identity

No roster, no registration flow, and teams still have no account and no password (P8.2). A `team`
row is created when a token is issued, and the token points at it. That is the whole mechanism:
identity was already being handed out, it just was not being recorded.

The consequences fall out of it rather than being built separately. A submission takes its team
from the verified token, so the name on the form is a confirmation the team may **correct** —
and correcting it renames the team they already are. `uq_submission_current` moved from
`(lower(team_name), challenge_id)` to `(team_id, challenge_id)`, which is what makes the version
chain survive a rename.

Issuing now also requires a contact. It is the only channel to a team whose repository will not
clone, and there is no account to fall back on.

### One definition of "the same name"

`team_normalise(text)` — lower-case, drop a leading "the", strip punctuation — is declared once
in migration 063. The stored `normalised_name` column is generated from it, the similar-name
lookup calls it, and the browser calls neither: it asks the server. Writing the expression out
in the table and again in the application is two declarations that agree until one is edited
(P1.5 clause 6).

It **warns**; it never merges. "Night Shift" and "The Night Shift" may genuinely be two teams,
and a form that silently collapsed them would be inventing a fact. What was missing is that
nobody could see the collision at all.

### The backfill, verified against real legacy data

One team per distinct `(lower(team_name), challenge_id)` — conservative, because the old data
cannot show that the same name under two challenges was the same people, and a migration must
not decide that it was.

It ran against an empty table in every environment that exists, which is exactly the condition
under which a backfill goes unexamined. So it was applied to a scratch database seeded with the
awkward cases: a team that renamed between versions, a case variant, the same name under two
challenges, a token matching two teams, and a token matching none. The result was right in every
case — the renamed team's two versions collapsed to one lineage with the chain intact, the
cross-challenge namesakes stayed separate, the ambiguous token was left **unbound rather than
guessed at**, and the new unique index rejected a duplicate current entry.

An unbound token is refused at submission time with a message saying to ask for a replacement,
and it shows as unbound in the organiser's token list — because a token that will fail is worth
seeing before a deadline rather than at one.

### What a team can find out for themselves

`GET /submissions/mine` is on the P8.1 allow-list beside `POST /submissions`, for the same
reason and with the same factor. It accepts **no team parameter at all**: the team comes from the
verified token, so there is nothing on the request to tamper with. A test asserts the consequence
anyway, because "there is no parameter" is an argument and a passing test is evidence.

Each failing outcome names an action rather than a condition. The reader has a repository they
can change and a deadline — "PRIVATE" tells them nothing, "make it public, or re-grant access,
then submit again to re-check" tells them what to do while they can still do it.

And the submission form now links the published rubric once a challenge is chosen. A published
rubric was already a precondition of accepting entries — it exists precisely so teams can read
it — and until now nothing on the page said where. The slug comes from `v_rubric_publications`
(P1.3) and is the **publication's** slug, not the challenge's, because that is the key the public
endpoint resolves by; an E2E test fetches the link to prove it.

### A gap the second review found

A team whose only token was revoked still looks like a team everywhere else. It simply cannot
enter — silently, until the deadline. The token panel now names them.

### Two things noted and not built

- There is **no HTTP rate limiting anywhere in this system**, including on `POST /auth/login`.
  `/submissions/mine` inherits that. It is not an exposure here — a token is 192 bits of entropy
  — but the absence is systemic and predates this epic.
- The client still declares every response shape by hand. This epic split `Team` from
  `TeamListing` on both sides rather than sharing one type for two genuinely different responses,
  which is the careful version of the wrong answer. Shared contract types remain unbuilt.

### Verification

`pnpm verify` clean: **1945 tests across 112 files**, plus **160 E2E journeys**. Thirty
integration tests cover identity, the rename, the version chain and the scoped read; sixteen API
contract tests cover what a token can and cannot reach; eleven web tests cover the team's own
view; twelve E2E journeys walk the three team-facing paths and the organiser's side of them.

One pre-existing E2E assertion broke and deserved to: `getByRole('status')` on the intake page
had always assumed there was exactly one live region, and the new advisory made that false. It
addresses the intake state by test id now.

---

## G18 — decided: no Reviewer / Judge on the scoring calls

Raised while closing G6, put to the project owner rather than decided by the implementer, and now
answered: **Crucible does not apply Worker / Reviewer / Judge to the four scoring call keys.**

The work here is not an implementation. It is making a decision durable, which in this codebase
means three things.

### The principle was amended, not quietly departed from

P4.3 read as though every CRITICAL call key followed the pattern, and named six. Four of them —
the calls that actually produce scores — never did. A principle that claims a control the system
does not have is worse than an absent principle: it is the thing a reader checks *instead of*
checking the system.

P4.3 now scopes itself to `llm_call_registry.requires_review`, states plainly that **criticality
is not a synonym for reviewed** (it governs retry policy, terminality and logging), and carries a
table of all six keys saying which is which. [ADR 0004](adr/0004-no-reviewer-judge-for-scoring.md)
records the reasoning, the controls standing in the pattern's place, and — the part that matters
most for a decision taken without evidence — **what would reverse it**.

### The declaration already existed and nothing read it

`llm_call_registry.requires_review` has been there since the gateway was built. It is `true` for
exactly one key, `rubrics.criteria_generate`, which genuinely has `rubrics.criteria_review` and
`rubrics.criteria_judge` behind it. It is `false` for the four scoring keys.

So the database has been telling the truth the whole time, and the principles document has not.
That is the same shape as G2's unread config pin and G6's `reviewer_model` column: a recorded fact
nobody consults. The fix is the same one — make the declaration the thing that is read.

### Pinned by a test, because prose does not hold

`reviewRequirement.test.ts` asserts the exact set of reviewed keys and requires every CRITICAL key
to be either reviewed **or** exempt with a stated reason. The list is written out rather than
derived: a test computing "everything not reviewed" would welcome a new unreviewed key silently,
which is precisely the failure being guarded against. A CRITICAL key added later appears in
neither list and fails by name. Same mechanism as the P8.1 allow-list pin, same reason.

### Two things my own test caught

Writing the exemption list, I initially left out `rubrics.criteria_review` and
`rubrics.criteria_judge` — both CRITICAL, and both correctly unreviewed, because **a review pass
does not get its own reviewer**. The "every critical key is accounted for" assertion failed and
named them, which is exactly what it exists to do.

And three exemption reasons read `'ADR 0004.'` — an entry, not a reason. The test that requires a
reason longer than a citation failed on them. Both are small, and both are the test doing the job
the prose could not.

### What was deliberately not done

No control was weakened to pay for this. The exception removes a control that was never built; it
does not trade away one that was. Citation verification, the three validations, deterministic
evidence selection, temperature 0 under a per-run pin, the double score run, the calibration gate
and human review of the cut band all stand unchanged.

### Verification

`pnpm verify` clean: **1,950 tests across 113 files**, plus **160 E2E journeys**. Five of those
tests are the pin.

---

## E20 — Registering a cohort from one file

E17 made issuing a token the act of registering a team. That left registration correct and
impractical: fifty teams is fifty form-fills, fifty copy-pastes, and fifty plaintexts each shown
exactly once. This is the same operation in one step.

### Two steps on screen, on purpose

The check writes nothing and says what would happen per row — new, matches a team that already
exists, or cannot be acted on. The alternative is finding out after fifty teams exist, and the
only way back from that is deleting teams, which this system does not do.

**A file with any bad row is refused whole.** Issuing the good rows would leave an operator
reconciling which of their teams exist against a file that does not say. And the issue itself is
one transaction: twenty teams created and the twenty-first failing would leave twenty plaintexts
that were never returned to anybody — tokens that exist, belong to teams, and nobody holds.
`issueSubmissionToken` gained an optional `client` so bulk issue is one path with single issue
rather than a second implementation of the same rules.

"Already registered" is decided by `team_normalise`, the same function the stored column is
generated from — so "already in this file" and "already in the database" mean exactly the same
thing. Matching by exact spelling would reintroduce G13 at fifty times the scale.

### The bug that made the feature pointless, twice over

The first wiring called back to the page on issue so the token list beside it would refresh. The
intake page blanks to a loading state while it refetches, which **unmounts its children** — so
the refresh destroyed the panel holding the only copy of every token that had just been issued.
Precisely the failure the whole path exists to avoid, introduced by the convenience of keeping a
list current.

The E2E caught it: the teams and tokens were all in the database, and the screen showed an empty
form. Two changes followed. The file and the plan now live on the **page**, where a refetch
cannot reach them — the same pattern the single-token panel already used, which is why that one
never had this problem. And the refresh happens when the tokens are **saved**, not when they are
issued.

### What the tests are actually for

The assertion that matters is not that the response contains something shaped like a token. It is
that the file an organiser sends out from contains working ones. So the E2E downloads the file,
reads the plaintext out of it, and uses it on the submission page — and a web test reads the blob
back through `FileReader` to check the token column is populated and that a replacement is marked
as one. A file of team names with an empty token column would pass every other test here.

### A file I destroyed, and what the tests knew that I did not

`apps/api/src/lib/csv.ts` already existed. I wrote the new parser into it with `cat >` without
reading it first, deleting `csvDocument` — the writer behind every export in the system. The
typecheck named all three call sites immediately, so nothing shipped, but the content was gone
and there is no version control here to recover it from.

Reconstructing it took **three rounds, each one corrected by a test I had not written**:

1. The first attempt was a plain writer. The intake API test failed: the original also
   **neutralised spreadsheet formula injection**, so a team name of `=cmd|calc` exports as
   `"'=cmd|calc"` rather than as something that runs when an organiser opens the file.
2. With that added, the full suite failed on four export tests expecting `"YES"`, `"FINAL"` and
   `'"","","","",""'`. The original **quotes every cell, always** — which is why five blank
   decision cells read unambiguously rather than as four stray commas.
3. And that exposed something I had built wrong independently: the browser was writing the bulk
   token file with its *own* minimal quoting. Two writers for one format, drifting from the day
   they were written.

The writer now lives in `@crucible/contracts` and both sides import it, so the file the browser
saves is byte-identical to the one the server renders for the same plan — formula neutralisation
included, since a token file is opened in a spreadsheet by definition. It has unit tests of its
own now rather than being covered incidentally by assertions inside export tests.

One deliberate change while restoring it: a cell that is a plain number is exempt from
neutralisation. Without it every negative value in every export becomes text to protect against
nothing, and `-1+cmd|calc` is not a number so it is still neutralised. I cannot claim that
matches the original — it is a decision made in reconstructed code, recorded here because the
reasoning is not recoverable from the file.

**The lesson is the boring one**: read before overwrite, including for a file whose name sounds
new. The suite is what made this recoverable rather than silent.

### Verification

`pnpm verify` clean: **2,022 tests across 117 files**, plus **168 E2E journeys**. Twenty-four
integration tests cover the plan and the issue, eighteen unit tests cover the reader and eight
the writer, fifteen web tests cover the panel, seven API tests cover the contract, and eight E2E
journeys walk it in a browser.

---

## E21 — The calibration gate could not be run at all

"Let's run calibration" turned out to mean "find out why calibration has never run". It could
not. Not *had not* — **could not**, by any route through the application.

### What the probe found

Walking the whole workflow against the development cohort: golden set created, nine entries
spanning STRONG/MIDDLING/WEAK with all four required edge cases, two independent hand rankings,
sealed, gate criteria recorded. Every step succeeded. Then:

```
REPORT REFUSED: None of this golden set's entries appear in run 3.
                Score the set before comparing against it.
```

`golden_entry.submission_id` connects a ranked repository to the submission the machine scored.
It is written by `linkSubmission()` in the database layer, and **nothing called it** — no service,
no route, no UI. `generateReport` could never succeed.

The same shape as G2's unread config pin, G6's `reviewer_model` and G17's flagged-provenance
query, and the highest-stakes instance of it: the gate is what P0 says must pass before this
system ranks anything, and it is what [ADR 0004](adr/0004-no-reviewer-judge-for-scoring.md)
defers to when it declines Worker/Reviewer/Judge.

**Why a green suite hid it.** `calibration.test.ts` imports `linkSubmission` from the database
layer and calls it directly. The report was well covered — through a door only a test had the key
to. The new tests reach it the way an organiser does, and that is the whole point of them.

### The link, and why it refuses

Entries match submissions by canonical repository URL, through the same `checkUrl` intake uses,
so "the same repository" means one thing here. Checking writes nothing; an organiser sees an
entry nobody submitted **before** the report refuses rather than after — the old refusal named
the *run*, which is a long way from the entry that has nothing behind it.

It refuses a partial link. A report over five of the nine repositories the committee ranked is
not a report about that golden set, and the correlation would carry the set's name while
answering a different question. Two submissions pointing at one repository is `AMBIGUOUS` rather
than a guess, because a guess here becomes the evidence the gate rests on.

Both sides are canonicalised in the service rather than matched in SQL: a submission that has not
validated yet still holds whatever was pasted, so a SQL equality would find only the entries that
happened to be typed in the normal form.

### Two things the rehearsal found that nothing else would have

**The development cohort had not been scored since E13.** Every team had one of seven criteria
scored — the objective RUNS one — and six unscored. The seeder's fake model cited a fixed excerpt,
`export async function handle(event: TelemetryEvent) {`, which appears in **none** of the fixture
files. Since E13 every citation is checked against the scanned source, so all of them were
`CONTRADICTED`: **486 `SEMANTIC_INVALID` scoring calls**, and a seed that still reported success.
The composites everyone had been looking at on development screens were derived from the build
probe alone. The citation verifier was working perfectly; nothing was listening. The seeder now
quotes the marker comment, which every fixture file carries as its first line by construction.

**The weakest-dimension finding could never appear.** E11-S02 promises three things, and the third
is which dimension's ordering least resembles the human one. The code excluded any dimension not
scored for *every* entry — and a golden set spans a scaffold and a repository that will not build
precisely so that some dimensions cannot be scored. Every dimension was excluded on every
realistic set. It now drops the unscored **entry** from both sequences rather than the whole
dimension, keeps a minimum sample of five so a correlation over three repositories is not
reported as a finding, and the rehearsal immediately produced something worth reading.

### The rehearsal, and what it is not

The cohort lacked a `WRONG_PROBLEM` repository — one of the four edge cases a golden set must
span — so the fixture gained one: polished, tested, runs, and answers a different brief entirely.
The fake model scores each team from a single declared quality, which cannot express that, so a
`fidelity` override was added and asked for by criterion name.

It ranked **2nd of 13**. Both rankers put it 12th. That is the edge case doing exactly its job:
a scorer that rewards polish over relevance, caught by the one entry designed to catch it.

```
rank correlation : 0.676   (recorded minimum: 0.70)
sample size      : 13
material disagreements : 2 (recorded maximum: 2)
  Selwyn Row  WRONG_PROBLEM  human 12  machine 2   delta -10
  Aldgate Analytics VERY_LARGE human 3 machine 6   delta  +3
dimensions: CHALLENGE_FIDELITY 0.908 · ENGINEERING_QUALITY 0.859
            PRINCIPLES_STANDARDS 0.700 · RUNS 0.377 · ORIGINALITY 0.315
```

A **NO_GO** was recorded, with a rationale saying plainly what it is. **This is not evidence about
Crucible.** The machine side is a deterministic development fake that answers from the fixture's
own declared quality; the correlation says nothing about the scoring model. What it establishes is
that the gate can be walked end to end, through the services an organiser uses, and that when it
disagrees it says something specific enough to act on.

Genuine calibration still needs three things this cannot supply: a model provider key (none is
configured, so the real scorer has never run), real repositories, and real committee members
ranking them independently.

### Verification

`pnpm verify` clean: **2,050 tests across 119 files**, plus E2E. Thirteen integration tests cover
the link and reach the report through the application, four API contract tests cover the endpoint,
eleven web tests cover the panel, and two E2E journeys walk it.

---

## E22 — Two ways in: a CLI for the gate, and a CLI path to the model

Two blockers on running a real calibration, and neither was about calibration.

### `pnpm calibration`

The gate could only be reached through the web application, which is the wrong shape for the job.
A golden set is a dozen repositories described in a file, built once; the committee's rankings
arrive as two files from two people who never saw each other's.

The commands follow the convention already used for `db:*` — `tsx`, a pnpm script, flags parsed
by hand — and the reference implementation's shape for the same kind of tool: a usage block in
the header, `--flag value`, human-readable sections on stdout.

```
status      every set, what it is waiting for, and its latest verdict
bootstrap   build a set from a CSV, enter each repository, link them
score       run the scorer over the set, as run 1 or run 2
link        match entries to submissions; --confirm to record
rank        one ranker's ordering, from a file
readiness · seal · criteria · report · decide
```

`status` prints a `next` column, so the next command is obvious rather than remembered.

**Every command goes through the services the web application calls.** Nothing reaches into the
database to do something the product cannot do — that is exactly the mistake that hid the missing
entry-to-submission link, and a CLI is the easiest place in a codebase to repeat it.

`bootstrap` enters each repository through the ordinary **on-behalf** path, so the golden set is
scanned, probed and scored by the code a real entry meets. A set scored by a shortcut would
calibrate the shortcut.

### A model reached through a CLI, not only over HTTP

Provisioning an API key is separate procurement from installing a tool, and the gate should not
be blocked behind it. `cliProvider` spawns a locally installed CLI in print mode, reads its JSON,
and returns the same `ProviderResponse` the HTTP adapter does.

The contract made this one strategy file and one registry line, which is what it was designed
for. Everything above the provider — the gateway, classified retry, citation verification, the
call log — cannot tell which was used. Only `llm_call_log.provider` records the difference,
because an auditor is entitled to know.

Four decisions worth stating:

- **HTTP stays preferred.** The CLI is second in the preference order, so provisioning a key
  changes which path runs and nothing else.
- **The prompt goes on stdin**, not in argv. A scoring prompt is tens of kilobytes of untrusted
  source, and an argv that size fails on every platform at a different limit.
- **It replaces the tool's own system prompt** rather than appending to it. Crucible's prompts
  are versioned and pinned per run (P4.4); inheriting an unrelated operating prompt would make a
  score depend on the tool's version as well as on the rubric.
- **`isAvailable()` does not run the model.** A health check that costs money every time it is
  asked is one nobody leaves enabled. A missing binary surfaces as a named `UNAVAILABLE` on the
  first real call.

Failures are classified the way the gateway already understands: a kill on timeout is `TIMEOUT`,
a missing binary is `UNAVAILABLE` naming the way out, a non-zero exit is `PROVIDER_ERROR` quoting
what it printed. Output that is not JSON, a reply the tool marked as an error, and a reply with no
result text are each refused with their own message rather than returned as an empty completion —
an empty completion would reach schema validation, be retried three times, and hide that the tool
answered nothing at all.

Proven against a real model: the provider returns a scored JSON object, and `providerFor()`
selects `cli` on a machine with no API key.

### A candidate golden set, checked rather than remembered

`docs/calibration/golden-set-realworld.csv` — thirteen repositories, every one verified through
the GitHub API for stars, size, last push and archived status rather than recalled. They are
RealWorld implementations, which matters: they all answer **one published specification**, so
CHALLENGE_FIDELITY has something real to measure, and the same brief is implemented well and
badly across the set.

### Verification

`pnpm verify` clean: **2,066 tests across 120 files**. Sixteen unit tests cover the CLI provider
with the subprocess stubbed — a suite that spawned a real process would be slow, would need the
tool installed, and would spend money.

---

## E23 — Moving a team, and keeping what it was moved from

Three states already existed — `SHORTLIST`, `EXCLUDE`, `HOLD` — with mandatory reasons enforced
by a `CHECK`, and the decision panel already offered all three. So the ask looked satisfied. Two
things were not.

### Reviewers could not decide

`POST /review/runs/:id/decisions` was `requireRole('organiser')`, on the stated reasoning that
reading the evidence and deciding who presents are different acts.

The reasoning does not survive contact with who is in the room. **The people who read the
evidence are the committee**, and requiring an organiser to transcribe their conclusion puts a
person between the judgement and the record of it — which is the opposite of what this record is
for. It is now `reviewer` and above, and the row carries whoever made it either way.

**Finalising stayed organiser-only.** Deciding about one team and closing the whole list are the
two acts that genuinely differ.

Two existing tests asserted the old policy — one in `review.test.ts`, one in the access-control
matrix. Both were rewritten to assert the new rule and say why, rather than deleted. A deliberate
policy change should leave a louder trace than a passing suite.

### Moving a team destroyed the decision it moved from

`upsertDecision` was `ON CONFLICT DO UPDATE`. Moving a team from `SHORTLIST` to `EXCLUDE`
overwrote the decision, the reason, the author **and** the timestamp.

P7.1 names `review_decision` as append-only, and this table's own header calls it "the record an
appeal is answered from". *Why was this team excluded* had an answer. *Who shortlisted them
first, who changed it, and what did each of them say* did not.

Migration 065 applies the pattern used everywhere else here: supersede, never overwrite. The
unique constraint moved to a partial index on the standing row, and the write supersedes first
and inserts second — inserting first collides with the row it replaces, the same ordering lesson
the submission chain and the discovery runs each taught once already.

The trigger now enforces three things at the database rather than in a service:

- once the shortlist is `FINAL`, nothing changes (unchanged);
- a decision cannot be **deleted**, only superseded;
- a decision cannot be **edited** — every substantive column is compared, and only the two
  supersede columns may move. That last clause is the one that matters: without it, append-only
  is a convention the next bulk update will not know about.

The audit payload now names what a decision replaced, so a move reads as a move rather than as a
second unrelated decision about the same team.

### What a reviewer sees before moving a team again

The panel shows the standing decision, and now — collapsed — every decision the team was moved
from, with who moved them and why. Only the superseded ones: repeating the standing decision
underneath itself would read as though the team had been decided twice over.

A person about to change a decision is exactly the person who should see that it has already been
changed twice.

### Verification

`pnpm verify` clean: **2,081 tests across 120 files**, plus 170 E2E journeys. Eight integration tests cover the move,
the history and the two database refusals; five API tests cover the role change and the history
endpoint; four web tests cover what the panel shows.

---

## E24 — The evaluation finishes by itself

Reviewers were in the critical path, and not where their judgement belongs.

The batch ran `scan → probe → discovery → score` and stopped. Between a scored cohort and
anything a reviewer could look at were three more acts: compute the ranking, compute the
run-to-run variance, open the shortlist. None of them is a judgement — they are arithmetic and a
table — and every one of them was a person remembering to run something.

That is the wrong place for a human, for a reason worth stating: **a forgotten step looks exactly
like a cohort that scored badly.** An empty review page is silent about whether the ranking was
refused, was never asked for, or genuinely found nothing.

`finishRun` now runs at the end of every batch, inside the same run pin as the stages — the cut
line and the normalisation floor decide an outcome just as the scoring settings do (E14-S02). It
is idempotent, so resuming a paused run or re-running a finished one produces one shortlist and
one ranking rather than two.

Variance is computed only when both runs of the cohort exist. A comparison against a missing run
reports perfect agreement, which is the most misleading number this system could produce.

### The one deliberate stop, and why it pauses rather than fails

`computeRanking` calls `assertRankingPermitted`, and an uncalibrated system is refused. That stays
— it is the whole of E11-S03 — but it is now caught and turned into a **pause** with the gate's
own message, not an orchestration failure.

The difference matters. A failed run throws away the scoring; a paused one keeps it, and
recording a gate decision and resuming finishes the job. The scores were never the thing in
question: the gate refuses *ranking* only, and says so.

`feature.calibration.bypass_gate` still ships ON so development and the calibration run itself
can rank, and the pre-event checklist still turns it OFF. Nothing about that changed; what
changed is that turning it off now pauses a batch with an explanation instead of leaving an
operator to discover that ranking never ran.

### Where a reviewer now enters

At the end. A batch leaves a ranked cohort with an open shortlist, and the reviewer's job is the
one that needs judgement: moving a team between shortlist, hold and exclude with a reason, on the
surface E23 built, with the history of every earlier move beside it.

### Verification

`pnpm verify` clean: **2,089 tests across 120 files**. Eight new integration tests: that the
batch ranks and opens a shortlist unasked, that it withholds the comparison until the paired run
exists, that finishing twice leaves one of each, and that the gate pauses, keeps the scores, and
completes on resume.

---

## E25 — A GO now vouches only for the settings it measured

The gate already computed whether a decision covered the configuration in force, and the banner
already said *"this verdict was measured under different settings and does not vouch for a run
under the current ones."* Ranking proceeded anyway.

The fifth instance of the same defect — a recorded fact nobody acts on — and the most consequential,
because this is the control P0 puts in front of ranking. `assertRankingPermitted` now consults
`gateStatus` rather than the raw decision, and refuses on drift, naming what moved and how to get
back: put the settings back, or calibrate again under the ones now in force.

It refuses on an **unknown** configuration too. A decision predating configuration recording has
an empty pin, and "we do not know what it was measured under" is not "it is fine" — the same rule
the readiness report keeps when it declines to count UNKNOWN as ready.

Only settings declared `affects_outcome` are compared (E14), so raising a cost ceiling or
concurrency on the night invalidates nothing. A weight, a threshold or a cut line does.

### The first real calibration

`docs/calibration/RUNBOOK.md` documents the sequence. It was then walked, end to end, against
**thirteen real repositories** — not fixtures: cloned, scanned, Docker-probed and scored by the
real model through the CLI provider, twice.

```
run 1: scan 13 · probe 13 · score 13 · $2.30
run 2: scan 13 · probe 13 · score 13 · $2.20
rank correlation 0.61 (minimum 0.70) · 4 material disagreements (maximum 2)
```

**NO_GO**, and the report earned it:

- `PRINCIPLES_STANDARDS` correlates at **−0.383**. Not weak — *inverted*. The machine's ordering
  on that dimension runs opposite to the hand ranking, and no composite figure would have shown
  it. This is precisely the third thing E11-S02 insists a report carry, and it is the first time
  it has had anything to say.
- The three largest disagreements are all **frontend** implementations ranked far above backends.
  The rubric asks for the articles API and the follow relationship; a frontend answers neither.
  The scorer is rewarding general quality over the brief.
- All four edge cases agreed within one place. `SCAFFOLD_ONLY` 13/13, `VERY_LARGE` 10/10,
  `WRONG_PROBLEM` 12/11, `FAILS_TO_BUILD` 8/7 — the deliberately hard cases are the ones it gets
  right, and the ordinary ones are where it drifts.

### Two defects in the calibration itself, recorded in the decision

The hand rankings are **one author's, not a committee's**, so 0.61 measures agreement with one
reading. And the set mixes frontends with backends against an API-shaped rubric, which inflates
the disagreement. Both are written into the recorded rationale, because a NO_GO whose causes are
partly in the method is a different fact from one entirely in the scorer.

The bypass flag is now **off**, and ranking refuses with the recorded fallback — the first time
this system has enforced its own gate.

### Verification

`pnpm verify` clean. Nine integration tests cover configuration coverage: a GO under the settings
in force permits, drift refuses and says how to recover, putting the setting back permits again, a
non-outcome setting does not refuse, an unrecorded configuration refuses, and the bypass still
overrides all of it.

---

## E26 — Backends only, and a hypothesis that did not survive

Report 3 blamed its NO_GO partly on the set: frontends ranked above backends against a rubric
asking for the articles API, which a frontend does not implement. The obvious next move was to
split the set and rerun.

### Two things the rerun found before it produced a number

**Linking could not resolve a repository entered on two challenges.** Rebuilding a golden set
against a revised rubric submits the same repositories again, so nine of eleven entries matched
two current submissions and were reported `AMBIGUOUS`. The guard was right to refuse — picking
one would have put a guess into the evidence the gate rests on — but the workflow was impossible.
`linkGoldenSet` now takes an optional `challengeId`, `bootstrap` passes the challenge it entered
them on, and the CLI exposes `--challenge`. Honest and useless became honest and usable.

**The gate stopped the calibration run itself.** With the bypass off after report 3's NO_GO, the
first backend run paused at ranking — correctly, because calibration needs to rank in order to
have something to compare against. The runbook said to turn the bypass off at step 8 and did not
say to turn it back on to calibrate again. It does now, and `score` gained `--resume` so a pause
costs the reason rather than the cohort. The resume skipped every completed stage: $0.80 against
$1.71 for the original run.

### The finding

```
mixed set      ρ 0.610   4 material disagreements   13 entries
backends only  ρ 0.609   5 material disagreements   11 entries
```

**The hypothesis was wrong.** Removing the frontends changed nothing. Whatever the scorer and the
hand ranking disagree about, it is not set composition.

What persists is per-dimension, and it is where the useful signal turned out to be:

| dimension | mixed | backends only |
|---|---|---|
| `ENGINEERING_QUALITY` | 0.415 | **0.708** |
| `CHALLENGE_FIDELITY` | 0.589 | 0.466 |
| `ORIGINALITY` | 0.302 | **0.006** |
| `PRINCIPLES_STANDARDS` | **−0.383** | **−0.131** |

`ORIGINALITY` at 0.006 is no relationship at all, and `PRINCIPLES_STANDARDS` is still inverted.
Those two are the finding, and neither is visible in a composite. The machine also placed the
`FAILS_TO_BUILD` entry 6th where the hand ranking put it 9th — it under-penalises a build failure.

Both edge cases judgeable without reading code agreed exactly again: `WRONG_PROBLEM` 10/10,
`SCAFFOLD_ONLY` 11/11.

### The limit, recorded in the decision

The hand rankings are one author's, and they are derived from **repository metadata** — stars,
recency, archived status — not from reading eleven codebases. A disagreement between that proxy
and a scorer that did read the code is not evidence the scorer is wrong; it may be evidence the
proxy is.

This measures the method as much as the machine. It is written into the recorded rationale rather
than into a caveat somebody has to remember, because a NO_GO is only useful if what produced it
is legible afterwards.

### Verification

`pnpm verify` clean. Three integration tests cover challenge-scoped linking: the same repository
on two challenges is ambiguous, narrowing resolves it, and a narrowed search that finds nothing
says which challenge it looked in.

Total spend across both calibrations: **$8.86** for 48 scored submissions over four runs, through
the CLI provider.

---

## E27 — People, rooms and coaches

The three lists that have to exist before a team can submit, and that the system knew nothing
about: who the participants are, where teams will sit, and who is coaching them.

### Participants are records, not users

The same choice P8.2 makes for teams, for the same reason — 200 accounts for one weekend is all
risk and no benefit. What differs is that this is unambiguously **personal data**, and two
consequences are in the schema rather than in a policy document:

- a soft delete carrying a reason code, `GDPR_ERASURE` among them (P7.4), with a `CHECK` tying
  the three columns together so a `deleted_at` without a reason cannot exist;
- the unique-email index is scoped to the living rows, so erasing somebody does not block their
  later re-registration — and a test covers exactly that.

The audit trail records **which fields moved, not their values**. The roster is read by
organisers; the audit trail is read by more people than that, and a name is personal data
wherever it is written.

### Where it lives, and why not on `team`

`team_logistics` is its own table in a new `roster` module rather than two columns on `team`,
because `team` belongs to submissions. Per ADR 0002 a cross-module reference is a **plain column
resolved at the service layer**, not a foreign key — so this module holds `team_id` as a plain
column, while `room_id` and `coach_id` are real foreign keys because they are within it.

Rooms and coaches are **not versioned**. P7.1 reserves append-only history for state an appeal
turns on, and where a team sat does not decide a score. The audit event answers the question
actually asked: who moved them, and when, and from what.

### Refused versus reported

A room holds **at most one team**, enforced by a partial unique index — two teams in one room is a
problem in the physical world, not an untidy record. The database's refusal names an index, which
is no use to somebody moving a team, so it is translated into a message naming the clash.

A coach may take **several** teams. Six to one is a judgement, not an error, and a system that
refused it would be describing a world that does not exist.

### Two things the tests found

**`COALESCE` cannot express "clear this field".** The route contract says an absent field means
leave it alone and `null` means clear it — and the update statements read both as "leave it", so
an organisation could be set and never removed. Every nullable column now carries its own
"was it supplied" flag. The API test that caught it was written against the documented contract
rather than against the implementation, which is the only reason it caught anything.

**Re-uploading a list had to be normal.** The first draft treated a row naming somebody who
already exists as a conflict, which would make correcting a 200-person spreadsheet impossible —
the second upload would be 200 errors. A row matching an existing person is now `EXISTING`,
reported and not written, and re-importing the same file is a no-op that says so.

### Verification

`pnpm verify` clean: **2,149 tests across 123 files**. Thirty-one integration tests cover the
imports, the edits, the soft delete and the room clash; seventeen API contract tests cover who may
read a participant list — **a viewer and a reviewer may not**, because reading scores is not
reading personal data.

### Next

E28 is the epic the request was really about: assigning 200 participants to teams. Nothing of it
is built yet. E27 is what it needs underneath.

---

## E28 — Assigning 200 participants to teams

The epic the roster request was really about. The backend was straightforward; the surface was
not, and neither was what building it revealed.

### Membership, and the port it needed

`team_member`, with **one team per participant enforced by a unique index**. Two would make "who
submitted this" have two answers. The refusal names the team that already holds them, because an
operator reassigning somebody needs to know where they are now — that is the whole content of it.

The first member becomes the **point of contact** unless told otherwise, and their address is
carried onto the team, so the contact E17 requires is not a second thing to type.

Roster cannot write `team` — it belongs to submissions — so it goes through a new
`lib/ports/teamPort.ts`, registered at boot (ADR 0002). Unlike the audit port, an unregistered
implementation **throws**: a dropped audit event must not take down the action it describes, while
a dropped assignment has nowhere to go and silently doing nothing leaves an operator looking at a
roster that did not save.

### Three decisions the volume forced

- **Keyboard over mouse.** Type, Enter, next — the box clears and keeps focus. Drag-and-drop
  photographs better and is slower in the hand, and a misdrop is silent where a wrong Enter is
  visible.
- **The unassigned count is the largest thing on the screen.** It is the answer to "are we done".
- **Undo with no confirmation.** At this volume a misassignment is certain, and a dialogue on
  every action costs more than the mistake it prevents.

Plus: the selected team is **sticky**, because an operator fills one team then moves on; and a
`team_name` column in the participant file creates and assigns in one pass, matched through
`team_normalise` so a spreadsheet carrying "Night Shift" and "The Night Shift" produces one team
rather than two — G13 at spreadsheet scale.

### Four bugs, and only one of them was in the new code

**`COALESCE` could not clear a field** (E27, found by an API test written against the documented
contract rather than the implementation).

**`team_name` never matched.** The optional-column lookup compared a *normalised* header against a
*raw* column name, so `team_name` never matched `teamname`. Every other optional column is a single
word, which is the only reason nothing else revealed it.

**`useAsyncData` discarded its result on every refresh.** The hook refuses to show a result from a
previous key — correct when the dependencies change, because that result answers a different
question. But a **reload is not a new request**: the same question asked again still has the old
answer, possibly out of date. Collapsing the two blanked the page on every refresh, unmounting
whatever the caller was rendering. On this surface that destroyed the focused search box and the
selected team after every single assignment. The hook now separates "which question this answers"
from "which request produced it", and exposes `refreshing`.

That fix alone did not work, and the reason is worth recording: the page was passing a
`reloadKey` as a **dependency**, so every refresh still changed the question. Refreshing through
the hook's own `reload` is what made it hold.

**Every 204 response threw in the browser.** `request` returns `body as { data: T }`, and a 204
has no body — so `body` was null, and `del` destructuring it threw *after* the server had done the
work. The row was gone, the UI reported a failure, and nothing refreshed. This is **pre-existing**:
`revokeToken` has the same shape and nobody noticed, because no test asserted the state after a
revoke. Found only by instrumenting the browser's requests and seeing a `DELETE → 204` with no
refetch behind it.

### What the unit tests structurally could not catch

Two of those four were invisible to component tests, and for the same reason: **a component test
never refetches.** It renders once with fixed props, so an unmount-on-refresh and a focus loss
after a reload cannot happen in it. Nineteen passing web tests said the assignment surface worked;
the E2E said it lost focus after every keystroke. Both were telling the truth about what they
tested.

### A fixture the gate correctly broke

E25's configuration check refused the E2E's own gate fixture, which seeded a GO with no recorded
pin. That is right — "we do not know what it was measured under" is not "it is fine" — so the
fixture now records the settings in force, and the refusal stands.

### Verification

`pnpm verify` and the full E2E suite clean. Thirty-one integration tests cover membership, the
port and the readiness checks; nineteen API contract tests; nineteen component tests; twelve E2E
journeys walking type-Enter-next, undo, removal and the import.

---

## E29 — Getting the code to the team

Two of the three stories. The third is deliberately unbuilt and the reason is below.

### Issue for every team that has none

The file-driven bulk issue E20 built assumes the teams do not exist yet. Once the roster has built
them — which is now the usual order — there is no file to assemble, and asking an organiser to
export forty names in order to re-import them is work the tool invented rather than work the job
requires. One button now covers it.

A team already holding an active token is **reported and not reissued**. Two live tokens per team
is two answers to "who submitted this", and a second would not stop the first working. A team whose
only token was revoked *is* reissued, which is what makes the stranded-teams warning actionable.

The two paths are distinguishable in the UI by construction: every row of a team-built plan has
line 0, because there was no file for it to have a line in. Confusing them would hand out a token
per team unasked.

### The conflict a roster makes visible

A coach who is also a reviewer or judge is deciding about work they helped produce. Coaches are not
Crucible users and participants are not either, so before the roster existed **nothing in this
system connected the two — which means nothing detected it.**

The check matches coach addresses against `v_governance_actor` — the published view, not
`crucible_user` (P1.3) — for anyone at reviewer or above, and names the person and the teams they
coached. A **warning, never a refusal**: at a small event the same person may legitimately hold
both roles, and what matters is that somebody knew rather than that the system had an opinion. A
viewer is ignored, because reading is not deciding.

### The mailer is not built, on purpose

E29-S02 was marked optional in the plan and stays unbuilt. Sending would need an SMTP host,
credentials and a decision about a provider, and I would be shipping an adapter I could not send a
single real message through. The export file works today and an organiser can mail-merge it; that
is a worse experience and an honest one.

What it needs to be built properly: a mail port with one adapter, credentials from the environment
registered with the redactor, **no address and no token in any log line**, per-team delivery state
so a team who cannot submit is visible rather than a silent gap, and sending kept out of every
evaluation call path.

### A mistake in how I checked my own work

The web typecheck failed for several edits and I did not see it, because I was grepping the output
for `error TS` — which the `--pretty` formatter does not emit in the form I was matching. The
bundle was broken, the Vite dev server served it, and **twenty-three E2E tests failed on pages that
had nothing to do with the change.**

The fix in the code was two missing declarations. The fix in the method is to read the **exit
code**, which is what `pnpm verify` does and what I had stopped doing while iterating quickly.

### Verification

`pnpm verify` clean: **2,227 tests across 126 files**, plus **182 E2E journeys**. Ten integration
tests cover issuing for teams; seven cover the coach conflict; five API contract tests; two
component tests.

## E30 — The one acceptance criterion I had left open

Asked whether the work was done, I went back through the story acceptance criteria rather than
answering from memory. **E28-S02 acceptance 7 — "creating a team from this screen" — was not
built.** The assignment surface had no way to make a team; its empty state told the operator to go
and issue a token or re-import a file with a `team_name` column. That is exactly the interruption
the story exists to prevent: a team that does not exist yet is the commonest reason an assignment
cannot be made, and at 200 rows leaving the screen costs the position the operator had in the list.

### The control takes the person along

`POST /api/v1/roster/teams` creates a team and, optionally, puts its first member on it. The
assignment surface offers **whoever is currently at the top of the search** as that member, named,
with a checkbox to decline — because that person is almost always why the team is being created at
all. Taking them along also gives the team its contact address, which is how E17's token reaches
it.

The new team is **selected the moment it appears on the board.** Without that the selection stays
on whatever team was chosen before, and the operator's next Enter puts somebody on the wrong team —
silently, which is the single failure this surface's whole design exists to avoid. It is the reason
creation blocks where assignment does not: the board has to have caught up before the next
keystroke lands.

### Both refusals happen before anything is written

- A name that is an existing team **after normalisation** — "the night-shift!" against "Night
  Shift" — is refused by name. Silently assigning to the existing team under a name nobody typed
  would hide the collision rather than report it.
- A first member already on another team is refused, naming that team.

Each check runs before the team is created, so a rejected attempt leaves **no empty team behind**
for somebody to puzzle over later with no record of why.

### A team nobody can be written to

Creating a team with nobody on it means it has no contact address, and E29 sends tokens to that
address. Nothing in the system noticed. The import had the same hole already: a row with a blank
email column wrote `''` into `team.contact_email` and no reader ever looked at it — **the
"recorded fact nobody reads" defect for the sixth time.**

`roster_team_contact` is a fifth readiness check: it names the teams with no usable address, and
says which of them are empty, because the fix differs — put somebody on it, or name a point of
contact among the people already there. Empty and NULL are treated alike; the distinction depends
on which path created the team, which is not something an organiser can act on.

### A P1.3 violation I had introduced in E28

All four E28 readiness checks read `team` — a table the **submissions** module owns. Appendix C
allows a module to read another's data only through a published `v_*` view, and none existed, so
four queries reached across a module boundary into a base table. Nothing failed, which is why it
needed finding rather than waiting: the checks work until the day `team` changes shape, and then a
module that never asked for the dependency has one anyway.

Migration `070` publishes `v_team` — identity, contact, origin and the normalised name, but not
submissions' own `updated_at` and `created_by` — and all five checks now read it. There are no
direct reads of `team` left anywhere in the roster module.

`AssignBoard` was at exactly its 250-line limit, so `TeamList` moved to its own file unchanged
rather than the limit moving (P1.4).

### Verification

`pnpm verify` clean at exit 0: **2,247 tests across 127 files**, plus **184 E2E journeys**. Ten
integration tests cover creation and the contact check, four API contract tests cover the route and
its refusals, six component tests cover the control including the wrong-team-after-create case, and
two E2E journeys walk it.

## E31 — The roster surfaces that existed only on the server

A question about what the app could do — add a participant, load coaches, add a coach, assign a
coach to a team — turned up a clean split between what was built and what was reachable.

| Asked for | Before |
|---|---|
| Add a participant by hand | No endpoint at all |
| Load coaches from a file | Worked |
| Add a coach by hand | No endpoint at all |
| Assign a coach to a team | Endpoint yes, **UI no** |

`updateParticipant`, `updateRoom`, `updateCoach`, `getRooms`, `getCoaches` and `assignLogistics`
were all declared in `apps/web/src/lib/rosterApi.ts` **with no callers**. E27-S01 acceptance 4 and
E27-S02 acceptance 2 say every field is editable, and E27-S03 is entirely about moving a team to a
different room or coach. All of it was built on the server, tested on the server, and never put on
a screen — so from the only position that counts, the organiser's, the stories were not delivered.
I had reported E27 complete. **The "declared but unread" defect, now in its seventh instance and
the first to span a whole epic.**

### What was added

Three create endpoints (`POST /roster/participants`, `/rooms`, `/coaches`), each refusing a
duplicate **by naming the record that already exists** — the operator typing a second Ada Lovelace
needs to know she is on the roster, not that a unique index was violated. The match is the same one
the import uses, so "already there" means one thing however the record arrived (P1.5 clause 6).

Four tabs on the roster page rather than four routes, because an organiser moves between these
constantly on the morning of an event and a page load between each would throw away their position
in a list of two hundred:

- **People** — add, search, correct in place, remove with a reason. The reason *is* the
  confirmation; a dialogue on top of a required reason is ceremony, not safety (P7.4).
- **Rooms & coaches** — add both; a room goes **out of use** and a coach **inactive**, never
  deleted, because a room used yesterday still has to exist for the record of who sat where to
  mean anything.
- **Logistics** — one row per team, two selects. A room already allocated is shown **as taken,
  naming the team that has it**, rather than quietly missing from the list: the database refuses
  the second allocation, and an option that had vanished would leave the operator hunting for a
  room that appears not to exist.

### Two accessibility faults the tests found

Both surfaced as E2E failures and neither was a test bug:

- The in-place edit form had fields labelled `Full name` and `Email` — **the same names as the add
  form directly above it**. Anyone tabbing in landed in an unlabelled cluster of identical inputs.
  The form now carries `aria-label="Edit <name>"`.
- The in-use and active toggles took their accessible name from the label text beside them, which
  says `In use` or `Out of use` **depending on the control's own state**. A control whose name
  changes when you use it cannot be found again by the person who just used it. They are now named
  for the room or coach; the visible text still carries the state.

A third E2E failure was mine: `uncheck()` asserts synchronously, and these boxes are controlled by
the server's answer, so the assertion raced the round trip. `click()` plus an assertion on the
outcome is the honest form — the product behaviour was right.

### Verification

`pnpm verify` clean at exit 0: **2,272 tests across 129 files**, plus **190 E2E journeys**. Eight
integration tests cover adding by hand, four API contract tests cover the routes and their
refusals, thirteen component tests cover the three panels, and seven E2E journeys walk the whole
surface.

## E32 — Room and coach, where the team is named

E27-S03 acceptance 4 says room and coach appear "wherever a team is identified to an organiser:
the intake dashboard and the team review page". They appeared on neither. E31 surfaced them on the
roster's own screens; this puts them on the two screens the criterion actually names.

### A port, because there are two consumers

`team_logistics`, `room` and `coach` belong to the roster. The intake dashboard belongs to
submissions and the team review page to review. Reading roster's published view from both would
be the same query written out in two modules' `db/` layers — two declarations of one fact (P1.5
clause 6) — so `logisticsPort` carries it instead, registered by roster at boot beside
`teamPort` and `auditPort`.

**Its unregistered implementation is a loud no-op, not a throw — the opposite of `teamPort`.** The
distinction is what the data decides. A team's room decides nothing; it tells an organiser where
to walk. An intake dashboard that refused to load because nobody had wired the roster would be
trading the page that chases failing submissions for a fact about seating. A dropped team
assignment has nowhere to go, so that port still throws.

### What each screen shows

- **Intake, "Needs chasing"** — a `Where` column beside the team. Chasing a team means walking to
  them, so where they are belongs next to who they are. A team nobody has placed reads **"no
  room"**, not a blank cell: a blank reads as a rendering fault, and "nobody has said" is a fact
  an organiser acts on (P5.1).
- **Team review** — a line under the header: *Worked in Ada Room · coached by Margaret Hamilton*.
  A reviewer answering an appeal is reconstructing the day. It renders **nothing at all** for a
  team the roster never placed, rather than an "unknown room" line — inventing a fact to fill a
  field is the opposite of what that page is for.

A team with no room and no coach is **absent from the port's map**, never a row of nulls, so
neither consumer has to tell "placed nowhere" apart from "placed in null".

### Verification

`pnpm verify` clean at exit 0: **2,278 tests across 130 files**, plus **194 E2E journeys**. Six
integration tests cover the port and both of its failure modes — including that the dashboard
still lists what needs chasing with no port registered — and four E2E journeys walk both screens,
each testing the absence as well as the presence.

## E33 — The number the calibration figure is read against

Crucible measured how much the machine agreed with a human consensus and **never measured how
much the humans agreed with each other.** A ρ of 0.61 therefore looked identical whether the
people behind that consensus were near-identical or barely related — and in the second case there
is no stable human ordering at all, so the machine is being marked against noise.

`perRankerCorrelation` already existed, but it compares each ranker to the **machine**, never to
another ranker. Nothing in the system computed rater-versus-rater.

### What it found on this database

All five golden sets, run through the new measure:

| set | lowest pair ρ |
|---|---|
| 1 — discarded probe | 1.000 |
| 2, 3 — rehearsal | 0.989 |
| 4 — real-world set | 0.978 |
| 5 — backend set (both NO_GO reports) | **0.973** |

Set 5's two "independent" rankers are **one ordering with three adjacent pairs swapped**, entered
under two names. Both of the standing NO_GO verdicts were measured against a consensus that was
one opinion, and nothing anywhere said so. The report now asks the question:

> Two rankers at ρ 0.973. That is high enough to be worth asking whether the two rankings were
> arrived at independently — if one was derived from the other, or both from the same source, the
> consensus is one opinion and the agreement figure is an artefact rather than evidence.

Raised as a **question, never a finding**: two people reading eleven repositories really can land
this close, and nothing in the data can tell the difference.

### Three deliberate choices

- **The worst pair, not the average.** A consensus is only as trustworthy as its least-agreeing
  pair, and averaging would have hidden the outlying ranker that makes it untrustworthy. Every
  pair is reported individually for the same reason.
- **One ranker gives `null`, never 1.0.** A single person agrees with themselves by construction.
  Reporting that as perfect agreement would be the most misleading number in the report.
- **It changes no threshold.** The gate criteria are recorded before the report on purpose
  (E11-S03), and turning this into a second bar afterwards would be choosing a threshold once the
  number it has to clear is known. It qualifies the verdict; it does not become one.

The caveat travels **on** the coefficient — appended to `correlation_note`, which is stored with
the number — rather than beside it, because the reader who sees the figure is the reader who has
to know what it was measured against. It is appended only when agreement is not STRONG; a caveat
on every report teaches readers to skip the note.

### Also measured before sealing, where it can still be acted on

The calibration report comes **after** the set is sealed, and sealing freezes the rankings. By
then the answer to "these two barely agree" can no longer be *have them talk about what the
dimension means*. So `readiness()` computes the same number before the irreversible step, and the
workbench shows it in a **`warnings` list distinct from `problems`** — problems refuse the seal,
warnings inform it. A set that *can* be sealed but whose rankers agree implausibly closely is the
dangerous case precisely because nothing stops it.

While there, one word came out of the ready message. It read *"N independent rankings"* — nothing
in the system could establish that two people had not conferred, and the word was asserting
something never checked. It now says *"N hand rankings"*, and the agreement figure says how far
apart they actually landed.

### Verification

`pnpm verify` clean at exit 0: **2,299 tests across 132 files**, plus **194 E2E journeys**. Nine
unit tests cover the measure itself — including the eleven-repository swapped-pairs case that
prompted it — six integration tests cover the report carrying and propagating it, and six
component tests cover both surfaces.

## E34 — The mail port, and a placeholder that is not a stub

E29-S02 was left unbuilt because I would have been shipping an adapter I could not send a single
real message through. What was buildable without that decision is everything around it, so this
builds the port, the delivery record, the surface — and one adapter that composes exactly what a
real one would and transmits nothing.

### One fact forces the whole shape

**A token's plaintext exists for a single moment**, inside the response to the request that issued
it; `access_token` holds a hash (P8.3). So delivery cannot be a job that runs later over stored
credentials, because there are none to run over. It happens in the act of issuing, or it happens
by reissuing. That is why `deliverIssued` takes the issued rows rather than reading them back, and
why `POST /submissions/tokens/for-teams` grew a `deliver` flag instead of delivery becoming its
own endpoint.

The same fact governs what is written down. `token_delivery` holds **neither the token nor the
address**: the token because a delivery log carrying it would be the second permanent copy of the
credential that hashing exists to prevent, and the address because it already lives on
`team.contact_email` and a second copy drifts the first time somebody fixes a typo (P1.5 clause
6). What is left is the part actually in question — which token, to which team, by what route,
whether it went, and why not. Two tests assert the token and the address appear in neither the
table nor the audit payload.

### PREPARED is not a lesser SENT

The recording adapter composes a real message and hands it back. Its delivery record says
`PREPARED`, which means *a message was composed and given to a provider that does not transmit* —
the operator has the text and delivery is theirs. Recording that as `SENT` would claim something
nobody did, and the whole point of this table is that a team who never got their code is visible.

It is not a stub to be replaced before the event. An organiser with forty addresses and a
mail-merge is a working delivery route; this one is just honest about being it. The composed
messages are offered as a download **once**, on the screen that issued them, with the warning that
they exist nowhere else — the same lifecycle as the tokens inside them, because they contain them.

### The surface counts the failures

The primary number is **teams not reached**, not messages sent, because the gap is silent: a team
that never received its code does not complain, it simply fails to enter. `NONE` is shown as its
own state rather than folded into failure — nothing was attempted for that team, which is a
different problem with a different fix (P5.1).

`MAIL_API_KEY` is registered with the redactor at boot alongside `JWT_SECRET`, before any adapter
can use it, and every provider error is passed through `redactString` before being stored — a mail
service's error text routinely quotes the credential it was handed.

Nothing here is reachable from an evaluation path. Scoring, ranking and the batch orchestrator
never call it; an evaluation that could send mail would make a scoring run's side effects
unpredictable.

### A defect the E2E suite found, which was not a test defect

One new journey passed alone and failed in the full run. `token_delivery` references `team` and
`access_token` by **plain column, not foreign key** (ADR 0002), so a seed's `TRUNCATE team
CASCADE` never reaches it — and `RESTART IDENTITY` then hands the next team the same id, which
silently adopts the orphaned delivery rows.

Four seeds now clear it explicitly. The integration harness needed no change because it derives
its truncate list from the schema rather than a hand-written list, which is the same "one
declaration" argument that keeps being right. In production nothing hard-deletes a team, so the
adoption cannot happen there — but it is worth recording as the cost side of ADR 0002's ledger.

### Verification

`pnpm verify` clean at exit 0: **2,318 tests across 134 files**, plus **196 E2E journeys**. Eleven
integration tests cover the port and the record — including both "nothing is written down" cases
and a provider that actually sends — eight component tests cover the surface, and two E2E journeys
walk it.

### Still a decision, not a defect

Which provider to use. **Resend** if there is a domain whose DNS can be edited (free at forty
teams, fastest credible path); **Postmark** for the strongest transactional deliverability at
~$15/mo; **not SES**, which starts sandboxed and can take days to leave it. Adding one is a
strategy object and one line in `PROVIDERS` — nothing above `mailPort` changes.

## E35 — ORIGINALITY measures what the criteria actually ask

The dimension was built to answer *"how much of this is the team's own work rather than generator
output"* — a question about **provenance**. The judging criteria ask *"does the solution employ an
innovative or creative approach"* and *"does the application incorporate a novel approach"* —
questions about **inventiveness**.

A dimension measuring one construct while its raters judge the other produces no relationship
between them, and that is what calibration found: **ρ 0.006**, against 0.708 for engineering
quality over the same eleven repositories. This does not *prove* the mismatch caused it — two
people have yet to rank the set independently — but it is the leading explanation and by far the
cheapest one to remove.

### What changed

Prompt **version 2**, superseding version 1 rather than editing it: scores already produced were
produced under v1, and the record of what was asked has to survive the change (P7.1). Both
versions are readable; a test asserts v1 is still there and still says the old thing.

The new prompt names the four things inventiveness is *not*, because each is a way the construct
degrades: **volume** (three thousand lines of the obvious solution), **novel-sounding
dependencies** (a library imported and barely used is a dependency, not an idea), **complexity**
(more complicated than the problem needs is a fault), and **polish** (which belongs to other
dimensions).

`ORIGINALITY_TARGET`'s evidence specification drives file selection through the context builder, so
it had to change too — it now describes *where an approach is visible* (how the core problem is
modelled, the algorithm at the heart of it, mechanisms the team built rather than imported) instead
of where authorship is visible. Selecting files to prove who wrote them would hand the model the
wrong evidence for the question it is now asked.

### The measurements changed job, not existence

Boilerplate share, template detection and provenance now **bound** the judgement instead of being
it: a submission with no substantive code cannot demonstrate an inventive approach, because there
is nothing there to be inventive. Above that floor they say nothing either way, and the prompt says
so — *"a team with 70% scaffold and 300 excellent lines may have out-thought a team who hand-rolled
3000 lines of boilerplate."*

The restraint carried over deliberately. Version 1 spent most of its length on what the
measurements do not prove, and version 2 keeps all of it: a recognised generator, commits outside
the window and one large commit are still facts about how a repository was assembled and still not
evidence about anybody's integrity.

The reviewer-facing surface was the other half. The panel heading, the dimension label an author
sees while writing criteria, the cut-band warning and the `ADVISORY_DECIDED` reason text all said
"originality" in the authorship sense. A stale label steers a committee into authoring for the old
construct, so all four moved.

### What this deliberately did NOT do

**It stays advisory.** Whether creativity may sink a team is a committee decision, and
`ADVISORY_DIMENSIONS` is untouched — there is a test asserting that, so flipping it has to be
deliberate. **The dimension keeps its name**: "originality" in the judging sense *means* an
original approach, and renaming would churn five modules to say the same thing.

## E36 — The attached documents are read

`submission.artifact_urls` has held up to five links per team since E03. Nothing ever read them:
not the scanner, not discovery, not scoring, and not the review page. A team that attached an
architecture document had it recorded and ignored — **the "declared but unread" defect for the
eighth time**, and the first where the unread field was load-bearing for a judging criterion.

Two criteria have no evidence anywhere in a repository: whether the presentation covers the
architecture, and whether the demo depicts the functionality. These links are the only place that
evidence can come from.

### Fetching is the dangerous part

This takes a URL chosen by a competition entrant and fetches it from inside the evaluation
network. That is server-side request forgery unless the boundary holds — and the text it returns is
then shown to a model that scores that same entrant, which makes it the most directly
attacker-controlled input in the system: the team chooses the address *and* every word at it.

Four defences, and only the first fails closed:

1. **An allow-list of hosts**, not a deny-list of private ranges. A deny-list has to be right about
   every redirect, every DNS rebind and every address family, and only has to be wrong once. The
   list starts at four hosts and a refusal **names** the host, so widening it is an organiser's
   informed decision rather than a guess.
2. **https only, no credentials in the URL** — the rule `checkUrl` already applies to repositories.
3. **A byte cap enforced while streaming**, because `content-length` is a claim by the same host
   that chose the body.
4. **Extraction through a port**, so only shapes a real extractor handles are read at all.

**Redirects are refused, not followed.** A redirect is the permitted host handing the request
somewhere that was never checked, which is precisely the hole the allow-list closes. The test for
it redirects to `169.254.169.254`, which is what that attack looks like.

The fetch error is deliberately not surfaced raw: a failure message can carry the resolved address
and tell an entrant about the shape of the evaluation network.

### Reusing extraction rather than copying it

PDF, DOCX, Markdown and plain-text extraction was built for challenge briefs and lives in the
**challenges** module. `extractionPort` exposes it; submissions consumes it. Copying four
extractors into a second module would be two implementations of one capability that agree until one
of them is fixed (P1.5 clause 6). Unregistered, it returns UNSUPPORTED rather than throwing —
extraction is best-effort by construction, so a missing wire degrades the way a corrupt PDF does.

### Six outcomes, because they need different fixes

`FETCHED`, `REFUSED`, `UNREACHABLE`, `TOO_LARGE`, `UNSUPPORTED_TYPE`, `EMPTY`. REFUSED means
Crucible declined — a host off the list; UNREACHABLE means it tried and failed. An organiser
widening an allow-list needs to tell those apart. `EMPTY` is a deck of images: read successfully,
holding no text.

A truncated document **says so** on the page, because a reader judging from the first 40,000
characters of 120,000 has to know that is what they are doing (P5.1). One dead link never fails the
others — a team with one 404 and one good architecture document ends up with the good one read.

Fetching is **organiser-only and never automatic on submit**: it is the one outbound request this
system makes on a team's instruction. A reviewer sees whatever was read, with no control to cause a
request — absent rather than present-and-refused.

### Verification

`pnpm verify` clean at exit 0: **2,346 tests across 137 files**, plus **196 E2E journeys**. Nine
integration tests pin the ORIGINALITY construct in the places a reader would have to change to undo
it; eleven cover the fetch boundary, five of them refusals; seven component tests cover the panel.

## E37 — A configuration value has to be what it claims to be

`PATCH /platform/config/:key` validated its body as `z.unknown()` and `updateConfigValue` wrote
whatever it was handed. Two consequences, and the second is the one that mattered.

**`app_config.value_type` has been declared on every row since E01 and nothing ever checked a
write against it.** A key declared `number` could be set to `"banana"`. The tenth instance of the
declared-but-unread pattern, and this one had been sitting under every setting in the system.

**A value of the right type in the wrong shape was stored silently.** Set `scans.event_window` to
`{"start": …, "end": …}` — the wrong field names — and it was accepted, reported as *set* by the
readiness check, and then read by the scanner as `null`. That **disables provenance windowing**
with a single `log.warn`, and every commit is counted as in-window. On a setting flagged
`affects_outcome`, pinned into every run, which the event's window had just been written to.

### One declaration, three readers

`configSchemas.ts` holds the shapes. `setConfig` refuses before writing; the `event` readiness
check and `scanService.readEventWindow` parse with the **same schema**. A schema the writer
enforces and the reader re-implements is two schemas that agree until one is edited (P1.5
clause 6).

The readiness check was the subtler fix. Its test was `startsAt && endsAt` — a presence check that
passes for dates which do not parse and for a window whose end precedes its start. It would have
reported the event as configured while windowing was silently off. It now fails the same way the
writer does, and says *unusable* rather than *not set*, because those need different fixes.

`readEventWindow` keeps its null return as defence in depth but logs at **ERROR**: reaching it now
means something bypassed the writer.

All five `json` keys got shapes, not just the motivating one — a JSON value that parses is not a
value that means anything. An empty `submissions.allowed_hosts` is refused because it would refuse
every submission; an empty `submissions.artifact_hosts` is allowed because fetching nothing is a
defensible choice.

### The first refusal was itself uninformative

`eventWindowSchema` was `z.union([z.null(), object])`, and a union reports `invalid_union` with the
real problems buried in branch errors. The live refusal read:

> 'scans.event_window' does not have the right shape: **Invalid input.**

Which is precisely the useless refusal this change exists to stop producing. Two fixes:
`.nullable()` on the object instead of a union with null, so the object's own messages surface;
and `problems()` now flattens union errors and de-duplicates, so a message cannot appear once per
branch. It now reads:

> startsAt must be an ISO timestamp with a UTC offset, e.g. 2026-10-03T12:00:00-04:00

The offset requirement carries an example on purpose. A bare `2026-10-03` parses as UTC midnight,
which moves both edges of the window by the local offset — the trap that nearly cost an hour on
each end of this event's window when it was set.

### Verification

`pnpm verify` clean at exit 0: **2,365 tests across 138 files**, plus **196 E2E journeys**.
Nineteen integration tests, of which thirteen are refusals; three assert the refusal says what is
wrong rather than that it happened. The live window survived the change unchanged.

## E38 — The receipt told every successful team their repository was unreadable

Reported from a real submission: a valid entry came back with *"No commit could be locked yet.
Your entry is recorded and your organiser will see that the repository could not be read — fix
access and submit again."*

The submission was fine. `validation_status` was **VALID**, detail *"The repository is public and
was cloned successfully."*

### The confusion

`locked_commit_sha` is set when the **intake window closes**, not at submit time. That is
deliberate and correct — a team keeps working until the deadline, and the commit they are judged
on is whatever is on the branch at that moment.

The receipt had two states and branched on the wrong fact: a locked commit, else a warning that
the repository could not be read. So **every team submitting successfully before the deadline —
which is every team — was told their repository was unreadable**, at the moment they had just
succeeded, and instructed to fix something that was not broken.

It is hard to design a worse false alarm. It appears on the one screen entrants see, it arrives
attached to a success, and acting on it means re-submitting repeatedly or spending the evening
chasing repository permissions that were always correct. On the day, with forty teams, it is also
forty support conversations.

### Three states, branching on validation

- **Locked** — the exact commit, and the note that later pushes will not change it.
- **Valid, not yet locked** — *"Your repository was read successfully. The commit you are judged
  on is taken when intake closes — so keep working."* The ordinary path, and it now reads as
  reassurance because that is what it is.
- **Not valid** — the warning, unchanged in substance, now shown only when it is true.

The distinguishing fact — `validationStatus` — was already on the receipt and simply was not being
read.

The E2E test that covered this asserted `/No commit could be locked yet|Commit locked/`, an
alternation that passed for either state and so could not detect the two being confused. It now
asserts the failure fixture reads as a failure **and** does not read as the reassurance.

### Verification

`pnpm verify` clean at exit 0: **2,370 tests across 139 files**, plus **196 E2E journeys**. Five
component tests, one per state plus the two properties that matter most: that a valid entry never
says "could not be read", and that a failed one still says the entry was recorded.

## E39 — The two surfaces that still needed curl

Both existed on the server and neither had a screen. `GET /api/v1/submissions` paged and filtered
properly with no web client function at all; `startBatch` was declared in `batchApi.ts` and called
by nothing. The eleventh and twelfth instances of the declared-but-unread pattern, and together
they were the only two places the night of an event would have required a terminal.

### Every entry, not only the failing ones

The intake dashboard itemises failures and counts everything else, so a perfectly good submission
was invisible: an organiser could read "12 valid" and still not answer *"what did this team submit,
and is it valid?"* That is the question asked on the day, by the person standing next to the team
asking it. It was answerable only by querying Postgres — which is exactly what happened in this
session.

The table filters server-side, names the challenge rather than printing `#9`, carries the real
backend total beside a bounded list (P5.7), and shows the version — the fact teams get wrong most
often, because they submit again and assume the first entry is gone. It was not; it was stood
down, and this is version 3.

### Starting a run

Cohort key, which challenges, run 1 or run 2. Each is explicit rather than defaulted, because the
cohort key scopes ranking, the cut line and run-to-run variance — get it wrong and nothing fails,
a team is just ranked against the wrong field. The cost is stated **before** the click.

### Three defects found by building it

**A panel took down the page it sits on.** The entries fetch had no `.catch`, unlike every other
optional read on that page, and a single 400 blanked the whole intake dashboard — counts, chasing
list, delivery and all. The empty page is a far worse outcome than a missing panel. The 400 itself
was mine: `MAX_PAGE_SIZE` is 100 and I asked for 200.

**The filter reset itself the moment it was used.** Filter state lived inside the table; changing
it changes what the page asks the server for, which blanks the page to a loading state and
unmounts the table, taking its state. The selects snapped back to "All" and the list came back
unfiltered, which reads as the filter simply not working. The roster's assignment surface lost a
focused search box to this same mechanism, and it is the third time `useAsyncData`'s dependency
blanking has cost something. The filter is now the page's state and the table is controlled.

**Starting an existing cohort and run CONTINUES it, and nothing said so.** `openScoreRun` reuses
the run for a (cohort, index) pair deliberately — a resumed batch must write its remaining scores
into the run holding the rest. Correct for a resume, and silent for a typo: mistype the cohort key
and the work merges into another run with nothing said. Nothing refuses it, so the panel now warns
before the click and the button reads **Continue run 1** rather than Start.

My own E2E test for that case is what surfaced it: it clicked Start expecting a refusal, and
instead **launched a real batch** against four fake seeded repositories. The test now asserts the
warning and deliberately does not click.

### Verification

`pnpm verify` clean at exit 0: **2,387 tests across 140 files**, plus **201 E2E journeys**.
Seventeen component tests across the two panels, including one pinning the filter-survives-refetch
regression, and four E2E journeys.

## E41 + E42 — A circuit breaker, and the team size rule becomes a rule

Planned in `docs/CRUCIBLE_EVENT_READINESS_EPICS.md`, whose E41 was rewritten before this was
built: the first draft proposed rate limits as protection, the objection was that no participant
should ever see an error, and the objection was right.

### The breaker

Ceilings sit an order of magnitude above the most demanding legitimate use, live in `app_config`
with the derivation written beside each, and one flag (`feature.http.rate_limit`) removes the lot
without a deploy. Reads teams poll — `/submissions/status`, `/mine`, `/challenges/open` — are
**deliberately unlimited**; polling is wanted behaviour. `POST /submissions` counts per token, so
two teams behind one conference NAT cannot exhaust each other. Every failure inside the limiter
lets the request **through**: a breaker that failed closed would take down submissions to protect
them. A coverage test pins that every public route either has a ceiling or is listed as unlimited
on purpose, in the same shape as the P8.1 allow-list pin.

The one limit set for security rather than as a breaker is `/auth/login`, which no participant
touches.

### Three mistakes, all found by the tests

**One number for two questions.** The first login ceiling was 20 per 15 minutes per IP *and* per
email. The test suite tripped it in seconds — 169 failures across eleven files, none of them the
file with the bug — and the suite is a fair stand-in for ten organisers behind one office NAT.
Split into two: per **email** at 20 (stuffing one account needs thousands of guesses; a forgetful
person needs five) and per **IP** at 600 (a breaker; a shared network must never reach it).

**The security bucket never counted.** The hook was registered on `onRequest`, which runs
**before the body is parsed**, so `req.body` was undefined and the per-email bucket was silently
skipped. The control existed and did nothing — the declared-but-unread defect, arrived at from a
new direction. Moved to `preValidation`, which runs after parsing and before the authenticating
`preHandler`, and a test now asserts a second attempt against one address is refused.

**The E2E suite is a robot.** It signs in as one account about two hundred times in twenty minutes.
139 journeys failed on "sign-in stayed on /login" — a 429 rendered as a form error, so a grep for
429 found nothing and the first diagnosis was wrong. The E2E seed now turns the breaker off with
the switch built for exactly this; the breaker itself is tested in-process where the limiter is
reset between tests.

### The size rule

3 to 8, by migration. One declaration (`teamSizeRule.ts`) serves two readings: **public
registration refuses**, because the rule is the contract with entrants; **an organiser is warned**,
because a half-formed team at 9am is normal and refusing to record one would describe a world that
does not exist. Both read the same numbers, and a test proves it — the failure this prevents is a
checklist that passes a team the registration endpoint would reject.

### Verification

`pnpm verify` clean at exit 0: **2,426 tests across 142 files**, plus **201 E2E journeys** in
1.7 minutes (the failed run took 18). Fifteen tests cover the breaker, most of them asserting that
legitimate volume passes; eight cover both readings of the size rule.

## E43 — Mail that actually sends

The placeholder adapter from E34 stays and stays the default. Beside it now sits `resend`, chosen
with `MAIL_PROVIDER=resend`, which needs only a key and a sender to go live.

### One header made retries safe

A timeout is ambiguous: the provider may have delivered and the acknowledgement was lost, so
retrying can send twice — and a token delivered twice is a credential in two inboxes. Resend's
`Idempotency-Key` returns the original outcome for a repeated key without resending, so every
message now carries one (`token-issued/<tokenId>`) on the port contract itself, **required rather
than optional**: the one message without a key is the one that gets delivered twice.

The rest is P12.2's discipline for any external call — a 15 s timeout, three attempts at
1 s / 2 s / 4 s, a breaker that opens for a minute after three consecutive failures — and P4.2's
classification: a 429, a 5xx or a timeout is retried; a 4xx is not, because a rejected address does
not become valid on the third try.

### Templates in the database, in their own table

P3.3 puts prompt wording in the database so an operator can tune it without a deploy, and the
argument is stronger for an email forty teams will read. But `llm_prompt_template` is keyed to
`llm_call_registry`, and registering an email there would make the LLM registry, its audit and
`listProviders` all describe a model call that never happens. So `mail_template`: same shape, same
versioning, supersede-never-edit, different table because it is a different thing. The `{{var}}`
substitution moved from the LLM module to `lib/` so both could share one implementation without
crossing a module boundary (ADR 0002).

Every template says what happened, what to do, and who to ask — in that order, tested. The token
appears in **exactly one** template, and a test enumerates every template to prove it.

### Three things the second review added

- **`MAIL_PROVIDER=resend` without a key or sender refuses to boot, naming both** — distinct from
  the default, which needs nothing. The boot error was dropping the *reason* for a cross-field
  rule ("required when MAIL_PROVIDER is resend"), leaving a contradiction of the default; fixed.
- **`provider_ref` was stored and shown nowhere** — the pattern again, on a column two hours old.
  The delivery panel now lists reached teams, collapsed so the unreached stay primary, with the
  provider's reference beside each — what support quotes back when a team says "we never got it".
- **The template version is recorded on each delivery.** Versioning wording is decoration unless
  "what did team X get?" has an answer after a rewording.

### A vacuous test, caught by its own guard

The no-secrets-in-logs test captured zero lines: the harness runs at `error`, so every `info` and
`warn` was dropped before the sink. An assertion over nothing passes. The `lines.length > 0` guard
was written for exactly this and fired; the test now raises the level for its duration.

### Verification

`pnpm verify` clean at exit 0: **2,454 tests across 146 files**, plus **201 E2E journeys**. Eight
unit tests on the adapter with `fetch` replaced, including that every retry carries the same key
and that a 4xx is never retried; ten integration tests through the port, including redaction of a
provider error that quotes the key back.

## E44 — Participants register their own teams

The second public endpoint, and the largest piece of the event-readiness plan. Four stories, all
built.

### Proof of an address is the whole authentication

A participant enters their own email. If it is on the roster and not yet on a team, a one-time
link is emailed — `crr_` prefixed so it can never be mistaken for a submission token, 192 bits,
SHA-256 at rest, single-use, expiring per `registration.link_ttl_minutes`. Starting again
supersedes the previous link. Holding the link is holding the right to form a team with that
participant in it; no account exists anywhere (P8.2).

### Nothing lists anybody

The screen looks like selection and never is one. The link resolves to the registrant's **own**
name, the open challenges and the size bounds — a test pins the response's exact keys. Teammates
are added by exact address, one at a time, and the server answers with one name or "not on the
roster". Chips render what was confirmed. The only `<select>` is the challenge, which is public
already. An API test asserts the participant and team lists stay behind authentication.

### Confirmation is one transaction across two modules

Team and token belong to submissions; memberships to the roster. Rather than import across the
boundary, `teamPort` gained a transaction `client` on `create` and a new `issueToken` — the
mechanism bulk-issue has used since E20. Everything commits or nothing does, and a test races two
confirms on one link: one wins, one loses, and **one** team and one token exist afterwards. The
token is emailed **after** commit, because a token emailed inside a transaction that then rolls
back is a credential for a team that does not exist. The response confirms it was sent and never
carries it.

### Four things the second review added

- **The chosen challenge had nowhere to live.** A team is not bound to a challenge until it
  submits, so the dropdown's answer was being written into an audit payload and forgotten —
  decorative. Now validated against the open list (a request body is not a dropdown) and recorded
  on the link that produced the team.
- **Registration emailed the token without writing a `token_delivery` row**, so a registered
  team whose email failed was invisible on the delivery panel — the silent gap E34 built that
  panel to close, reopened by the one path that did not write to it. Recorded through the port
  now, `SENT` or `FAILED`, both tested. The "Done" screen's copy was claiming an organiser could
  see the failure before that was true; it now claims only what the record supports.
- **A team formed by participants says so**: `origin = 'REGISTRATION'`, a fourth value beside
  TOKEN, ORGANISER and BACKFILL, because a reader deciding how much to trust a record needs to
  know how it came to exist (P5.1).
- **The E41 coverage pin did not understand wildcard allow-list entries** (`POST /register/*`
  covers three concrete routes). It now treats a wildcard as decided when a ceiling or an
  unlimited entry sits under it, and checks the reverse with `isPublicRoute`.

### Mistakes made and found

A doubled backslash in a heredoc left the integration file with an unterminated string, so it
"ran no tests" — the summary line for a file that failed to load, easy to read as empty. A fixture
name of one character tripped the name-length check before the assertion it was written for. My
first `TeamBuilder` had a synchronous `setState` inside an effect and a complexity of 26; the
name check is now derived from what was last checked rather than cleared by an effect, and the
builder is three components and one pure function (`reasonsToWait`, unit-tested on its own).

The epic's own acceptance text said the audit event should name "the registering participant's
address". That contradicts the roster's rule that participant data never enters an audit payload;
the actor is the participant id, and the document was corrected rather than the code bent.

### Verification

`pnpm verify` clean at exit 0: **2,496 tests across 149 files**, plus **206 E2E journeys**.
Twenty-two integration tests including the race, eight API tests including the no-lists
assertions, twelve component tests, five E2E journeys, and the P8.1 and E41 coverage pins both
re-pinned.

## E45 — Submission readiness, tier 1

Two stories. The first removes something; the second adds the checks that can refuse in seconds.

### The token is the team

The submit form asked for a team name and, since E17-S02, renamed the team to whatever was
typed. It was meant as a spelling correction; in practice it let a team rename itself on the
organiser's roster as a side effect of submitting, and a team that typed a teammate's name
renamed *them*. The field is gone. The token resolves — debounced, as it is typed — to the team
it names, the page says "Submitting as **Team**" with the count of previous entries, and a token
bound to no team fails at the field with the server's reason rather than at submission. The
resolve is the same token-scoped read as "Check my entry", so nothing on the page lists teams.
`teamName` left the request body, the service input and the draft; the three E17-S02 tests that
asserted the rename now assert its absence, including that no `team_renamed` audit event is
written and that each version's snapshot comes from the team, never the form.

The team's own contact address fills the email field once the token resolves. My first version
copied it into the draft from an effect; the lint rule against `setState` in an effect caught it,
and it is now derived — the draft holds what the team typed (`null` until they do) and the
resolved contact stands in meanwhile. A first attempt at that derivation keyed on the empty
string, which would have refilled the field the moment a team cleared it; the page test "keeps
the team's correction" pins that it does not.

### Checks that refuse in seconds, inside the one place entries are judged

Tier 1 runs inside `validateRepository`, after the clone and Dockerfile checks, using the
evaluator's own `scanRepository` (`@crucible/scanner`) and `originalitySignals`
(`@crucible/scoring`) — the same scaffold-versus-written measure the evaluator will apply later,
not a second implementation of it. Two refusals, each naming the problem and the fix: no README,
and fewer than `submissions.tier1_min_code_lines` (50) lines of code outside generated and
configuration files. The whole synchronous check shares one wall-clock budget,
`submissions.tier1_budget_ms` (25 s); a walk that exceeds it, or fails, records **PENDING** with
the reason — a fact about the moment, not the team — and never a refusal.

Because the default fake clone was a bare README, every existing intake test would have failed
tier 1. The fixture's default clone is now a legitimate entry (README plus sixty lines of code),
with `withEntry()` for scenarios that need a Dockerfile or a changed README on top; the scaffold
and no-README cases say so explicitly.

### What the second review found

- **A PENDING receipt told the team their repository "could not be read."** `CommitLine` had
  three states — locked, VALID, and everything else — and everything else was the E38 warning.
  A team whose checks merely ran out of time would have been sent to fix a repository that was
  fine. PENDING is now its own state: recorded, will be re-checked, nothing for you to fix.
- **That promise was an hour late.** Recording PENDING sets `validated_at`, so the revalidation
  tick would not have looked again until `revalidate_interval_minutes` (60) had passed.
  `selectForRevalidation` now treats a PENDING entry as always due; an integration test pins
  that the next tick turns it VALID.

### Mistakes made and found

The page test for the rejected-token path failed after every assertion had passed, with the
rejection itself as the error. The cause was `beforeEach(() => mock.mockReset())`: Vitest runs
a hook's return value as a cleanup, `mockReset()` returns the mock, and so the mock was being
*called* after each test. Braces around the body fix it; the file says why. Along the way I had
guessed at an unhandled-rejection cause and rewritten the mock twice before reading the stack
trace, which named `callCleanupHooks` on its fourth line.

### Verification

`pnpm verify` clean at exit 0: **2,507 tests across 151 files**, plus **208 E2E journeys**. Five
tier-1 integration tests (pass, no README, scaffold, configurable floor, budget → PENDING), four
page tests for the resolved team, one receipt test for PENDING, one revalidation test, and the
E17-S02 identity tests rewritten for the token-is-the-team rule.

## E46 — Submission readiness, tier 2 (built as `preflight`)

Everything that needs minutes, run after the request has returned. Three stories, all built.

### Named for what it is

Three readiness endpoints already existed — platform, roster and rubrics — and each means
something else. The module, its tables, its config and its mail keys say *pre-flight*; the epic's
wording stands and the document says which is which.

### The database is the queue

A `preflight_run` row is QUEUED by the port and claimed with `FOR UPDATE SKIP LOCKED`, so two
instances draining together never run the same one and a restart loses nothing but a tick
(P11.4). A partial unique index allows one live run per submission: a second trigger joins it,
and the API says "already queued" rather than showing a run that does not exist. Concurrency is
`preflight.concurrency` (2); a run still RUNNING after `preflight.run_timeout_minutes` is recorded
FAILED with the reason and the team told it could not be checked — never a submission stuck in
"checking". Submissions queue through `preflightPort` (a loud no-op unregistered, because
advisory work must not be able to fail the entry it describes), on the transition into VALID
only, so an hourly re-check does not build every entry every hour.

### No stage reimplemented

The checks call `scanSubmission`, `probeSubmission` and `discoverSubmission` — the services the
cohort run calls — under a `PREFLIGHT` ledger run with a stage per check. What the module owns is
the translation of an outcome into PASS, FAIL or UNKNOWN with words a team can act on. The rule
that matters: **a thrown service is UNKNOWN, never FAIL.** Only a recorded outcome about the
repository fails a check; Docker being down, a clone timing out, discovery switched off are the
harness, and the team is told "could not be checked". Build and run are two checks from one
probe because a team fixes them differently, and when the build failed the run is UNKNOWN —
"your app crashed" would be false. Provenance flags are not reported to teams at all: a check
that told a team which commit pattern looks suspicious would be teaching it. Discovery is
config-gated (seven model calls) and, when off, is *named* as skipped rather than silently absent.

The one new check, committed credentials, lives in `@crucible/scanner` as a short list of
high-precision provider formats plus PEM headers, run over the files the scan already read. A
finding names the file, the line and the kind, never the value — a report that quoted the secret
would be a second place it was committed (P8.3) — and its remedy says ROTATE, because deleting the
line is the fix a team reaches for and it is not enough.

### The team is told, either way

Three templates, one per verdict, in the database like every other message. None carries a
score or a hint at one; the PROBLEMS message says so in a sentence. UNKNOWN is its own message
("nothing for you to fix; an organiser has been told"), kept distinct from PROBLEMS all the way to
the intake screen. Every completed run writes a `preflight_notice` — SENT, PREPARED, FAILED, or
UNCHANGED when the same commit, verdict and findings were already reported, so "we chose not to"
and "we forgot" never look alike. An organiser-made entry with no address is a recorded failure
to notify, not a skip. The entries table gained a Pre-flight column naming the failing checks,
whether the team was told, and a Run checks / Run again button.

### Verification

`pnpm verify` clean at exit 0: **2,569 tests across 156 files**, plus **209 E2E journeys**. Nine
scanner unit tests, fifteen verdict unit tests, twenty-one integration tests (queue, ledger,
UNKNOWN-not-FAIL, secrets without the value, concurrency bound, dead-run recovery, every notice
state), nine API tests, eight component tests and one E2E journey.

## Review pass — E41 to E48, criterion by criterion

A second senior-architect reading of `CRUCIBLE_EVENT_READINESS_EPICS.md`, the whole document
and every acceptance line, against what was built. E43, E44 and E48-S03 held on every
criterion. Six gaps were found and closed; two epics that had not been started were built.

### What the reading found

- **E41-S01.7 — "surfaced on the operator health screen".** A tripped ceiling wrote a log line
  and nothing else. A log line nobody reads at 23:00 is not surfaced. The breaker now counts
  every refusal per route (no identifier kept, P8.3), `/api/v1/platform/health` carries it, and
  the Health page has a "Safety ceilings" section that says what a trip means: something is
  looping, find out what. A trip is not degradation — the system did its job — so the status
  stays HEALTHY.
- **E42-S02.3 — the declared-but-unread helper, again.** `assertCanRemoveMember` was written in
  E42 and called by nothing; removing a member from a registered team of three was allowed.
  `origin` now travels through the team port, and `unassign` refuses to take a `REGISTRATION`
  team below the minimum. Organiser-held teams stay unbound (acceptance 4) and the readiness
  checklist still names them when they are too small.
- **E45-S01.1 — "challenge history".** The resolved team showed a count of previous entries;
  it now names them by challenge and version.
- **E47-S01, option (a) — built.** `POST /submissions/teams/:id/reissue` takes a reason,
  revokes every live code the team holds and issues a new one in one transaction, audits
  `submissions.token_reissued` with the reason and the revoked ids, and returns the plaintext
  for the one moment it exists. The token panel's replace form asks why before it will issue and
  says the previous code has stopped working. Nothing recoverable is stored. Option (b) is not
  built: it weakens E17's design and S02.6 requires an ADR accepting that first — recorded in
  the epics document so the next reader finds the decision, not the absence.
- **E48-S01 — built.** `PATCH /submissions/teams/:id` for name and contact, organiser-only,
  audited through the existing `reviseTeam`, which now refuses a rename that collides through
  `team_normalise` and names the clash. An inline edit control sits on the token rows of the
  intake page and on the roster's team list. An entry keeps the name it was made under.
- **E48-S02 — deleted.** `@crucible/events` held fourteen event names and no publisher had
  existed since E01. Every cross-module need has been met by a view or a port, so the package
  went rather than stand as a contract nothing honoured. P12.1 in the principles now says when
  it comes back: with its first real event, subscriber and delivery test.

### Mistakes made and found

Running `pnpm verify` and the E2E suite at the same time, on a machine also carrying two
other dev servers, starved both: hooks timed out, sign-in itself timed out, and a thirty-minute
E2E run reported failures in specs I had not touched. Every one passed alone. The lesson is
operational and cheap: the suites run one at a time.

Two failures were real. The edit control's accessible name was `Edit <team>`, which also
matched every existing `getByRole('button', { name: /<team>/ })` and broke two roster journeys
under strict mode; it is named by id now. And the intake journey that queues a pre-flight run
left that run writing `build_probe` rows in the background while the next spec re-seeded —
`build_probe` has no foreign key (ADR 0002), so `TRUNCATE … CASCADE` did not reach it and the
re-seeded submission #1 inherited a probe it never had. The seeds now truncate those tables and
the journey waits for its run to settle. A third was mine by omission: the E17 reissue journey
still pressed the button E47 renamed.

### Verification

`pnpm verify` clean at exit 0: **2,602 tests across 161 files**, plus **211 E2E journeys**.
Added: thirteen integration tests (reissue, rename, collision, registered-team size), nine API
tests (team administration, health ceilings, ceiling trips), ten component tests (reissue
reason and copy, edit control, health page), and two E2E journeys.

## E47-S02 — Recoverable submission tokens, revealed under audit (ADR 0005)

Decided by the product owner after the review pass had built option (a) and stopped: an admin
must be able to see a team's **current** code, because on the day a team that lost its code
needs the one already in their email thread and their teammates' hands, not a new one that
invalidates all of those. The story's own acceptance 6 required an ADR before code, so ADR 0005
was written first and states the risk accepted in one sentence: between issue and lock, a
compromise of **both** the database and the reveal key exposes every live code, where the
database alone exposed nothing before.

### What was built

- **Sealed at the one insert point.** `issueSubmissionToken` is where every token — bulk,
  registration, reissue — is written, so sealing there covers all of them. AES-256-GCM with a
  fresh IV and the row's id as authenticated data, key from `TOKEN_REVEAL_KEY` (32 bytes,
  validated at boot, registered with the redactor), key id stored beside the ciphertext so a
  rotated key reports "unavailable" instead of failing to decrypt.
- **The hash still verifies.** A test corrupts the ciphertext and verification succeeds.
- **Reveal** is `POST /submissions/tokens/:id/reveal`, **admin-only** — the role that issues
  codes is deliberately not the role that reads them back — and it writes
  `submissions.token_revealed` (actor, team, token, time) **before** opening the plaintext, so a
  reveal that then fails is still on record; a test proves it by rotating the key between issue
  and reveal. It sits behind its own per-credential ceiling, the second security limit beside
  login, and `LIMITED_PRIVATE` pins that it is the only authenticated route allowed one.
- **Purged** at window lock (audited with the count) and at revocation; reissue drops the old
  copy and seals the new one. After lock there is nothing to reveal and nothing to steal.
- **Degrades, never fails.** No key: tokens issue and verify as always, reveal answers with a
  reason. A flag switches reveal off without touching what is stored.
- The token panel shows **Reveal** only on an admin's page and only for a sealed, live code,
  and says the code shown is the current one read back under their name, not a new one.

### Verification

`pnpm verify` clean at exit 0: **2,629 tests across 165 files**, plus **212 E2E journeys**.
Six cipher unit tests, eleven integration tests (sealing, hash-only verification, audit-before-
open, purge at lock, revoke and reissue, flag, no plaintext in logs), six API tests (admin-only,
unavailable-as-200, ceiling, listing), four component tests and one E2E journey.

## E49 — Discord as the delivery channel, email as the recorded fallback

Asked for by the product owner after the review pass, with four decisions taken up front: keep
email as the fallback, DM the team contact rather than a channel per team, collect the Discord
identity at registration, and one dedicated event server the bot lives in. Written up as E49 in
the readiness document first, then built.

### Two facts shaped it more than the preference did

A bot can DM only a user who shares a server with it and has not closed DMs. So the identity is
a **username resolved against the event server's members** at the moment it is typed — a name
the bot cannot find is a person it cannot DM, and the form says so then, not on the night. And
a DM that is refused anyway falls back to email in the same call, **recorded** as a fallback
with the reason, never silently.

The registration *link* cannot go by Discord: it proves control of an address the roster holds
(II.2), and the roster holds no Discord identity until the person registers. So the link stays on
email; the code, and every pre-flight outcome after it, goes to Discord when the team has one.

### What was built

- **One port, two channels.** `MailMessage` carries an optional Discord id beside the address;
  `MailResult` names the channel that carried it and, on a fallback, why Discord refused.
  `withDiscordFallback` wraps whichever mail adapter is configured — nothing above the port sees
  two providers. `token_delivery` and `preflight_notice` record the channel; the delivery panel
  shows *Discord DM*, *Email*, or *Email (Discord refused)*.
- **The adapter lives in `lib/discord/`**, not in a module: submissions needs it to DM and the
  roster needs it to resolve a username, and neither may import the other's services (ADR 0002).
  Same discipline as the mail adapter (P12.2): 15 s timeout, three retries with backoff on the
  transient, a breaker, and **REJECTED** — closed DMs, not in the server — never retried. A retry
  cannot deliver twice: Discord's message nonce is derived from the idempotency key and
  enforced. A body over Discord's limit is split at line boundaries, never truncated.
- **The identity, collected where it can be checked.** Registration asks for a Discord username
  (optional; the field does not appear at all without a bot configured), checks it on request
  against the event server, and confirms the display name. **The id a DM goes to is never taken
  from the request body**: confirm re-resolves the username server-side, because a body that
  named somebody else's id would send the team's code to a stranger. Not found: *join the event
  server first*, with the invite (`event.discord_invite_url`), and registration proceeds by
  email. The Done screen says which channel carried the code, and why not Discord when it was
  tried.
- **The roster carries it too.** An optional `discord` column on import (stored as given, resolved
  through the People tab where the organiser can be told the result), a field on the People tab
  with *(not found in server)* beside a name the bot could not find, and the point of contact's
  id travels to the team with the address — and is cleared when a contact without one takes over,
  so a team never keeps DMing its previous contact.
- **Personal data.** A Discord id appears in no log line and no audit payload; a test pins both.
- The health page says how teams are reached: the mail adapter, and whether Discord DM is live,
  off by flag, or unconfigured.

### What was left as stated

E49-S03.1 asked boot to log whether the bot is a member of the server. Boot makes no network
call in this system and should not start doing so for a delivery channel; the health page carries
the configuration instead, and the first DM or username check reports membership honestly. The
deployment notes in `.env.example` state the one permission the bot needs and that no privileged
intent is required.

### Mistakes made and found

A regex that rewrote the web `LinkScope` interface stopped at the first `}` — inside the nested
`bounds` type — and produced a file that parsed as nonsense until typecheck said so. And a
`discordNote` I returned from the participant services broke a test that pins a hand-added
participant to the exact shape of an imported one; the People tab already shows what the note
said, so the note went rather than the test.

### Verification

`pnpm verify` clean at exit 0: **2,660 tests across 168 files**, plus **213 E2E journeys**. Nine
adapter unit tests (classification, nonce, breaker, split, exact-match resolution), eleven
integration tests (channel recorded, refused-DM fallback with reason, flag off, username resolved
at confirm, not-in-server path, refused-at-confirm path, no id in logs or audit, contact carries
the id and clears it, import column), two API tests, nine component tests and one E2E journey.

## Deployment — Docker images and the AWS shape

Asked for as "dockerize and deploy to AWS". The shape follows from four facts the code already
states rather than from preference, and `docs/DEPLOYMENT_AWS.md` argues each one.

### Why one host

The prober builds and runs submissions in real containers — a tar context over stdin, `docker
cp`, `--network none`, memory and PID limits — so it needs a Docker daemon it can reach. Fargate
has none to expose. The app is single-process on purpose: the rate ceilings are in memory and say
so, the scheduler and the pre-flight drain are interval timers, the progress websocket is local.
Two replicas would silently halve every ceiling. So: **one EC2 `m6i.xlarge`** (sized for
concurrent submission builds, not the API), Docker Compose, a 200 GB root volume with a daily
prune of what builds leave behind, **RDS Postgres 16** for everything of record (backups,
point-in-time restore, encryption, deletion protection), and **Caddy** at the edge — TLS it
obtains itself, the static app, and `/api`, `/ws`, `/health`, `/ready` proxied, so the browser
sees one origin, which the API requires because CORS is off in production.

### What was built

- **`Dockerfile`, two targets.** `api`: the same `pnpm build` CI runs, pinned to the lockfile's
  pnpm, then production dependencies only, keeping the workspace *layout* (the marker file at
  `/app`, `db/migrations` beside it) because the API finds migrations by walking up to it. It
  carries `git`, `tar`, `tini` and the Docker **CLI** — no daemon — and talks to the host's
  through a mounted socket. `web`: Caddy plus the Vite build. 745 MB and 88 MB.
- **`docker-compose.yml`**: `migrate` runs to completion before `api` starts, so the boot-time
  schema check cannot fail on a fresh database; `web` waits for `api` to be healthy; named
  volumes for brief artifacts and for clone/scan workspaces so they cannot fill the root
  filesystem. `SITE_ADDRESS` is required so a real deploy cannot forget it.
  `docker-compose.local.yml` adds a throwaway Postgres and plain HTTP for a trial of the exact
  production images — which is how the stack was tested here: `/ready`, the public status route
  through Caddy, the SPA fallback, the security headers, and `docker version` from inside the API
  container against the host daemon all answered.
- **`deploy/aws/`**: a CDK app in TypeScript (first written in Terraform; replaced the same day
  at the product owner's request — `cdk synth` still yields the CloudFormation template) for a
  two-AZ VPC with no NAT, the host (IMDSv2, no port 22 — SSM Session Manager), the database
  (isolated subnets, from the host's security group only), one Secrets Manager secret the
  instance role can read and nothing else, an Elastic IP and an optional Route 53 record;
  `user-data.sh` (Docker, compose, CloudWatch agent, log rotation, the prune); `deploy.sh`
  (checkout a ref → secret to `.env` at mode 600 → build both images tagged by SHA → migrate
  alone → restart → poll `/ready`); a systemd unit so a reboot brings the stack back.
- **`pnpm user:create`** — the production path to a first admin. The seed refuses production by
  design (known passwords); this takes the password from the environment, never an argument,
  hashes it with the scrypt the login route verifies, never prints it, and updates on re-run so
  a locked-out admin is one command from back in. Tested.

### Mistakes made and found

Caddy refused its config on first run: `email {$ACME_EMAIL:…}` — compose passed the variable as
an empty string, and a Caddy placeholder default applies only when the variable is *unset*. The
contact address is optional for Let's Encrypt, so the line went rather than a default being
invented. And a sed that removed that key from the secret template left a trailing comma; the
template is now parsed in the smoke test.

### Verification

Both images build from a clean context; the local trial of the production images passes every
smoke check above; the CDK app synthesizes offline to a CloudFormation template with the
expected resources; `pnpm verify` clean at exit 0: **2,663 tests across 169 files**. The AWS
side has not been deployed from this machine — the first `cdk deploy` is the test, and section
2 of the deployment document is written to be followed literally.

The instance size was questioned and is now derived in the document rather than asserted:
`preflight.concurrency × probes.cpus` is four vCPUs for sandboxes alone.

## E50 — End to end: the event as one system

A senior-architect walk of the whole event — set up, roster, QR registration, calibrate,
submit, chase, deadline, two runs, one ranking — against the running app, with the product
owner's narrative as the script. Seven findings, recorded as E50-S01…S07 in the readiness
document; what held is listed there too, and is most of the system.

### The one that mattered

**What was evaluated was HEAD, not the locked commit.** `scanService` read `locked_commit_sha`
from the view and never used it — the "declared but unread" pattern this log keeps finding, this
time on the fact every appeal turns on. `withClone` had no way to check out a commit at all. A
team that pushed after the deadline would have been judged on the push, and the receipt's
promise ("this exact commit is what will be evaluated") was untrue. The clone now takes a
commit, fetched by sha and checked out detached, and both the scan and the probe pass the locked
sha once it exists (HEAD before, which is what pre-flight should see). A scanner test with a real
repository proves the checkout; an integration test proves a post-deadline file is absent from
the scan. No existing test had caught it because every fixture had one commit.

### The one that changed the design

**One ranking from two runs.** E06-S06 refused to average because averaging hides disagreement;
the event nevertheless ends with one list. The final ranking combines the two *stored* rankings
— weighted mean per submission, weights in config, the same tie rule and cut band as each run —
and every row keeps both composites, the delta, and a `disagreement` mark under the variance
report's own two conditions. So the list is made by averaging and is not allowed to hide what
E06-S06 protected. A submission scored in only one run keeps its composite and says so; the list
knows when a run was re-ranked after it. The review and shortlist workflow stays per run on
purpose: it is the record of human decisions against evidence, and the final list is what is
published from it.

### The rest

- **Incomplete is evaluable.** Tier 1 no longer refuses an entry with no README or too little
  code; both are the pre-flight *Substantive code* check, told to the team with what to add,
  fixable until the deadline. Tier 1 keeps only what an entry cannot be evaluated without.
- **Who is not there yet.** A list of registered teams with no entry and entries with unfixed
  problems, each with its last reminder; *Remind* one or all through the same port (Discord
  first, email fallback), recorded per team, from a versioned template with the deadline and the
  link. Offered only to roles that may send — a viewer saw a button that would 403 until the
  second review.
- **QR codes** for the two participant pages, generated in the browser from the configured
  URLs — the same ones the emails carry — copyable and printable; one click sets both URLs to
  this origin when unconfigured.
- **Phones.** No responsive rule existed. A signed-out visitor now sees a header with only
  *Register* and *Submit* (E44-S04.1, finally true); the staff nav wraps; tables scroll in their
  own box; inputs at 16 px so iOS does not zoom; print styles. A mobile-viewport journey asserts
  no sideways scroll on either participant page.
- **CSP and Permissions-Policy** at the edge.

### Mistakes made and found

The public/staff header used `useSyncExternalStore` with `getUser`, which parses storage on every
call and returns a fresh object each time — React's "getSnapshot should be cached" loop, and
every page crashed. The component test had mocked the session with a stable object and so
proved nothing about it; fifteen E2E journeys failed at once, which is how it was found. The
snapshot is now cached against the raw string, with a unit test that pins the reference. And the
chase table's accessible name contained the word "Teams", which an older journey matched by
label; the name changed, not the journey.

### Verification

`pnpm verify` clean at exit 0: **2,692 tests across 176 files**, plus **216 E2E journeys**
including two at phone width. Added: six merge unit tests, three clone tests, twelve
integration tests (final ranking, reminders, locked commit, substance), three API tests, seven
component tests, one session test, three journeys.

## E51 — Coach sheets (2026-09-26)

One page per shortlisted team, for the coach in the room: who, what they built, whether it ran,
two things to open with, and at most five questions — each because of something the run
recorded, citing the file. The rules are pure (`coachQuestions.ts`) and unit-tested; the composer
reads only through the review module's own detail and the other modules' published views (a new
`v_rubrics_criterion` for criterion names). Scope is the shortlist, or the cut line before any
decision. Sent by email to each coach for their own teams, recorded per coach; teams with no
coach are named in the result. The coach's copy never carries a score, a rank or a decision; the
organiser's screen and download do.

The first cut was eight questions with paragraph-length reasons. The organiser said one page,
not a document: now five, every line a sentence, and the "what they built" block trimmed to what
fits a glance.

### Verification

`pnpm verify` clean at exit 0: **2,723 tests across 180 files**, plus **219 E2E journeys**. Added:
ten unit tests on the question rules, nine integration tests (compose, scope, send, record),
eight API tests, four component tests, three journeys.

## E52 — End-to-end assurance (2026-09-29)

Six new Playwright suites, forty-seven journeys, written after reading every route, page and
existing journey and asking where two modules had never been made to agree in one run. The
lifecycle suite is the one that matters: it starts from four people on a roster and ends with a
real scoring run watched to its end on the batch page, with only the rubric and the registration
link seeded, because those need a model and a mail provider.

### What the suites found

Six defects, none of which a per-feature journey could see. The largest was on intake: every
organiser and admin control was rendered for a viewer, who would have been refused on the click —
the API was right and the screen was not. The subtlest was a screen-reader-only label: positioned
absolutely inside a table that scrolls sideways, it sat outside the scroll box and widened every
page by its own offset, so phones scrolled sideways for nothing visible. The most consequential
was the route guard, which checked the session once at render: a session the API refused mid-page
left the person on a page of errors instead of at sign-in. A double click on the public submit
button sent two entries. An unknown address rendered nothing. And the final ranking, keyed by
cohort rather than run, survived every re-seed and greeted the next journey as already computed.

### What the suites confirmed, and what I had wrong

The product's rules held where my expectations did not: the roster is an organiser read because
it holds addresses; an unknown registration link is refused as unauthenticated because the link is
the factor; a valid self-service entry is checked without anybody pressing anything; a run that
finishes says SUCCEEDED. Each of those was a test corrected, not a product changed.

### Verification

`pnpm verify` clean at exit 0: **2,723 tests across 180 files**, plus **266 E2E journeys**, run
sequentially.

## codeLinc 11 set-up (2026-09-29)

The opening presentation (`docs/2026-CL11-GSO-Opening Presentation.pdf`) was read in full, its
short links resolved, and the public reference material fetched. The two paths — Dental Benefits
Optimizer and Life Insurance Needs Analyzer — were written up as briefs in
`docs/challenges/codelinc11/`, with the event's rules and schedule as a third document, from the
slides' own words plus the reference sites' contents. The Lincoln Financial life-insurance pages
are a client-rendered application and yield only their descriptions to a fetch; the slides'
plain-language definitions (term versus permanent, the six inputs that shape need) were used
instead, which is what a team will read too.

All test data was removed from the development database (a backup was taken first). What
remains is what is not test data: the three development accounts, configuration, flags, the
principles and standards catalogue, the model call registry and the mail templates.

Each challenge has its brief, the rules and the presentation attached and extracted, a draft
rubric generated from the brief through the model (eight fidelity criteria each; one failed the
quality gate twice and was rewritten by hand so its top anchors are checkable from the repository
alone), and the four dimensions the generator does not produce added by hand: three engineering
criteria written for AI tools ("numbers are computed, not generated"; a failure does not lose the
conversation; the calculation is tested), one principles criterion on secrets and personal data,
the originality and runs hooks. Core requirements outweigh stretch and bonus items. Six principles
and two standards from the catalogue are adopted for the event. Both challenges are OPEN; both
rubrics are DRAFT, ready for the committee to approve, freeze and publish.

## Calibration planning for codeLinc 11 — three defects found (2026-09-30)

Planning the golden set (`docs/calibration/CODELINC11_PLAN.md`) meant reading how a golden entry
reaches the scorer. Three things were wrong.

**A golden entry was an entrant.** `eligibleSubjects` selected every VALID submission for a
challenge. Golden repositories are entered through the ordinary submission path on purpose —
that is what makes calibration measure the real scanner, prober and scorer — so they are VALID
submissions against the same challenge the teams enter. A real cohort run on the night would have
scored the reference repositories alongside the entrants and ranked them with them: the cohort
size that drives percentile normalisation would have been wrong, and a reference repository could
have displaced a team at the cut line. Migration 091 publishes
`v_calibration_golden_submission`; the batch excludes it; and the run that *does* score a golden
set names its submissions (`BatchInput.submissionIds`), so a golden entry is reachable only by
asking for it by id. Six regression tests pin both halves, the cohort count included.

**A blank optional variable crashed the boot.** `ANTHROPIC_API_KEY=` in an env file, or a key left
empty in a secret, failed schema validation and refused to start over a variable the process does
not need. Every optional variable now treats a blank value as absent, which takes the documented
path instead: model calls fail with a named error, token reveal stays unavailable, Discord falls
back to email.

**The test suite inherited the developer's model provider.** Enabling the local CLI for rubric
generation put `LLM_CLI_BINARY` in `.env`, and the next `pnpm verify` hung — not failed. Twenty
`claude` processes alive, the run stalled at 0% CPU, integration tests making real billable model
calls one at a time. Two unit tests had been asserting "no provider configured" by deleting the
variable, which `loadEnv` then repopulated from whatever that machine had configured, so they
passed or failed by accident. The integration setup now empties both provider variables, the
Playwright servers do the same, and the two tests set an empty value rather than deleting one.
The blank-is-absent change above is what makes that deterministic.

### Verification

`pnpm verify` clean at exit 0: **2,729 tests across 181 files**. Playwright **266 of 266**. Run
sequentially, with the dev servers stopped.

## The sandbox forced a working directory onto every Dockerfile (2026-09-30)

Building the golden set found the worst defect of the engagement, and it would have hit most
teams on the night.

`containmentArgs` ended with `--workdir /work`. That is right for the COMMAND path, which copies
the repository to `/work` and starts there. It was also applied when running an image built from a
team's own Dockerfile, where it overrides the `WORKDIR` the image declares. The ordinary
Dockerfile — `WORKDIR /app`, `COPY . .`, `CMD ["node", "src/server.js"]` — then cannot resolve its
own entry point: the container exits immediately and the probe records *"built successfully but
did not stay running"*. A correct, working submission is graded as one that does not start, on a
dimension worth 15% of the composite, and the reason recorded blames the team.

Every one of the eight dental reference repositories was graded `BUILDS_ONLY`, including the two
written to run perfectly. The dimension could not discriminate at all, which is what made it
visible: a spread designed into the set did not appear in the result.

`--workdir` is now a parameter rather than a constant. The COMMAND path still gets `/work`; the
Dockerfile path passes `null` and the image keeps its own directory. `HOME` follows, since a home
pointing at a directory the image may not have breaks tools that write there. Every other flag in
that function is a containment control and is unchanged — network denied, memory, CPU and PID
limits, no new privileges, all capabilities dropped, non-root user — and a test asserts they all
survive the change.

After the fix the same three repositories grade `RUNS`, `BUILDS_ONLY` and `BUILD_FAILED`
respectively, which is what they were built to do.

### Two further findings from the same run

**A build failure barely costs anything.** Reference A7 is the full, correct implementation with
one broken line in its Dockerfile. It does not build at all, and it still ranked **4th of 8**:
fidelity 98.5, engineering 82.5, runs 0, composite 75.9. At 15% weight, "does not run" cannot
outvote excellent code. Whether that is right is a judgement for the committee, and it is exactly
the kind of thing the gate exists to put in front of them — but if the three rankers put a
non-building entry last, the honest response is to raise the runs weight before the event rather
than to explain the disagreement away.

**The ordering control is documented but not enforced.** E18-S03 acceptance 3 says machine
scoring of a golden set is refused until at least two hand rankings exist. Nothing enforces it:
the CLI scored eight submissions with no rankings recorded, and the runbook's own step order
(score at step 2, rank at step 3) instructs exactly that. What *is* enforced is the control that
matters more — a report cannot be produced until the set is sealed, and sealing requires the
rankings — so no report can be fitted to a machine result. The residual risk is a ranker who is
also a reviewer seeing the ranking before submitting theirs. For this calibration the rankers work
from the repositories and the guide only. The gap should be closed after the event, in one
direction or the other: enforce the refusal, or correct the epic and the runbook to say that
scoring first is allowed and describe the control that actually protects independence.

### Verification

`pnpm verify` clean at exit 0: **2,732 tests across 181 files**, including three new containment
tests pinning both working-directory behaviours.

## Both golden sets scored (2026-09-30, late)

Sixteen reference repositories built, pushed and scored twice each through the full pipeline:
$44.46 for four runs, about 45 minutes per run on the local model CLI. Results and the three
disagreements they set up for the rankers are in `docs/calibration/CODELINC11_PLAN.md` §6b.

The result worth recording here is the reproducibility: **all sixteen entries held the same rank
across both runs of their set**, largest composite movement 4.1 points. That is the control the
double run exists to provide, and it passed without being tuned.

The finding worth acting on is asymmetric fidelity. The same "solves the wrong problem" trick
scored 12.0 on the dental rubric and 61.3 on the life rubric, because the life criteria describe
conversation mechanics rather than life insurance content — so any careful conversational
financial tool satisfies most of them. Whether to rewrite those criteria waits on the hand
rankings, which is the right order: if three readers also place that entry fourth, the scorer is
not the thing that is wrong.

## The holistic-comparison experiment (2026-10-01)

The committee asked whether one undecomposed model judgement would beat scored criteria, given
that the criteria had never been validated. Built as an experiment rather than argued about:
`scoring.holistic` sends one call per submission with the whole repository and no criteria, lands
in its own table that no ranking can read, and `pnpm calibration compare` correlates both
approaches against the hand ranking. Migration 092, three services, two CLI commands, sixteen
tests. Full detail and the result in `docs/calibration/HOLISTIC_COMPARISON.md`.

Three things came out of it that argument would not have produced.

**Cost was backwards from the intuition.** The holistic pass sends 37 KB and costs $0.09 for a
submission the per-criterion path sends 436 KB and $1.61 for. Per-criterion scoring re-sends
overlapping excerpts once per criterion; the holistic pass sends each file once. Cost is not an
argument against the committee's proposal.

**Reproducibility separated them cleanly.** Per-criterion scoring reproduced its ordering exactly
on both sets, 1.000 and 1.000. The holistic pass managed 0.958 and 0.898. Close, and not the same
thing when the output eliminates a team.

**They are blind in opposite directions.** The holistic pass ranked a non-building entry *first*
on set B, because it reads code and never runs anything. Per-criterion scoring ranked a
wrong-problem entry fourth, because the life rubric's fidelity criteria describe conversation
mechanics rather than life insurance. Each approach catches what the other misses, which makes
substitution a trade rather than an improvement.

### Verification

`pnpm verify` clean: **2,748 tests across 183 files**.

## The life rubric rewritten (2026-10-01)

The holistic experiment and the golden set agreed on a specific fault, so it was fixed before the
event rather than explained at it.

**The diagnosis, criterion by criterion.** Reference B8 is the dental tool submitted against the
life brief. Under version 1 of the life rubric it scored 61.3 on challenge fidelity. Looking at
where those marks came from:

| Criterion | Score | Why it passed |
|---|---|---|
| Collect all six situational inputs | 0 | Correctly caught |
| Conversation adapts | 1 | Partly satisfied by any stepped flow |
| Recommendation explained from the user's answers | 3 | The dental breakdown is explained from the user's answers |
| Editable answers recompute | 3 | Pure mechanics |
| Calm tone with non-advice disclaimer | 4 | Pure mechanics |
| Term vs. permanent | 0 | Correctly caught |
| Trade-offs specific to the scenario | 4 | **The rationale states it is a dental planner, then awards 4** |
| Sensitive answers handled with restraint | 4 | Pure mechanics |

Five of eight described conversation mechanics with no life-insurance substance in the anchors, so
a careful conversational tool about any subject satisfied them. The seventh is the clearest case:
the scorer noticed the wrong domain and still gave full marks, because the anchors asked only
whether trade-off text was personalised.

**The rewrite.** Version 2 anchors every fidelity criterion to the artefact only a life cover
needs analyser produces — a recommended amount of cover, derived from the six named inputs — and
gives 0 where that artefact is absent. "Recommendation explained from the user's own answers"
became "A cover amount, with the arithmetic that produced it", and carries the most weight of the
eight. Each criterion now says in its own description that a tool not assessing a life cover need
does not meet it at any level. That is not a trick to catch one fixture: a criterion about how a
recommendation is explained has nothing to assess when there is no recommendation.

Version 2 is approved, frozen and published. No real team entry existed under version 1, so
nothing was judged by the old wording.

### The rewrite worked, and exposed the real problem underneath

Re-scored under version 2, Reference B8 — the dental tool submitted against the life brief — fell
from **61.3 to 20.5** on challenge fidelity. The rewritten criteria do what they were written to
do, and the good entries did not suffer: B1 and B4 still score 100, B2 scores 98. Reference B6,
the scaffold, went to 0.

Its **composite** moved only from 77.7 to 67.1, and it stayed fifth of eight.

That is not a criteria problem, and modelling the alternatives showed no weighting fixes it:

| Dimension weights | B8's place |
|---|---|
| Current: fidelity 30, engineering 25, principles 20, runs 15, originality 10 | 5th |
| Fidelity-led: fidelity 50, engineering 15, principles 10, runs 15, originality 10 | 5th |
| Fidelity 45, runs 25, engineering 15, principles 10, originality 5 | 5th |

A composite is a weighted mean, so strength elsewhere always compensates. B8 scores 82.5 on
engineering, 89.3 on principles and 100 on runs — genuinely, because it *is* well-built software.
At fidelity 50% it still outranks B3, a weak but honest attempt at the right brief. No arithmetic
expresses "failing the point disqualifies you".

So the fix is not more arithmetic. Migration 093 and a new caveat, `LOW_CHALLENGE_FIDELITY`, raise
the case to a person: fidelity below a configurable 35, the mean of the other dimensions beside it,
and the explicit statement that the composite offsets this rather than overriding it and that an
entry which did not address the brief is a decision for the committee rather than an arithmetic
outcome. The threshold is set from the observed gap — the honest weak attempt scored 53, the
wrong-problem entry 20. It excludes nobody, which is the whole design: Crucible ranks and flags,
people decide.

## The challenge left the registration form (2026-10-02)

Teams register between 13:00 and 13:30 on the Saturday, before coding starts at 13:30. Most have
not settled on a path by then, so the question produced a guess — and a guess recorded as a
decision is worse than no record, because it reads like intent.

It cost nothing to remove, which is the part worth writing down: **nothing ever read it back.**
`registration_link.challenge_id` was written at confirmation and consumed by no query, no view and
no screen. The answer that matters is taken on the submission form, where the team knows which
path it took and is shown the published rubric it will be judged by.

Removed: the select and its "choose a challenge" reason from the form; `challengeId` from the
confirm contract and from the audit payload; `challenges` from the public link scope, which was
data a public response carried for a form that no longer reads it; and `selectOpenChallenges`,
dead once nothing called it. The column stays, nullable and now unwritten, because dropping it
would lose the record of the teams that did answer.

Two consequences worth noting. A team can now register before any challenge is open at all — the
old confirm re-checked the chosen id against the open list and refused when that list was empty,
which would have blocked registration on a setup step that has nothing to do with it. And the
registration email was still telling people to "pick the challenge", so migration 094 supersedes
it with a version that does not; an instruction to do something the screen does not offer is worse
than no instruction. Templates are versioned and content-hashed, and a unique index permits one
active version per key, so the old one is stood down in the same migration rather than edited.

The strongest assertion in the journey got stronger rather than weaker. It used to read "the only
dropdown is the challenge" and count one combobox, as evidence that no participant list is
offered. It now counts zero.

### Verification

`pnpm verify` clean: **2,758 tests across 184 files**. Playwright **266 of 266**.

## Pre-provisioned team slots (2026-10-02)

The organisers wanted the floor plan to exist before anyone arrives: "Team 7 — Hall A — coach
Margaret", printed and taped to a door, every room and coach settled the day before, and a
registering team taking the next free slot so nobody matches teams to rooms while fifty students
wait. I argued first for the simpler shape — auto-assign a free room and coach at registration,
no placeholder rows — and was wrong about the trade. A pre-provisioned slot is a physical artefact
you can print, and the whole plan is reviewable before the event. They reaffirmed, and the slot
model is what shipped.

A slot IS a team row, claimed rather than copied (migration 095). The submission token is the
team's identity (E17-S01), so two rows and a transfer would mean two identities for one team half
way through an event. `slot_label` survives the claim because it is what the sign on the door
says, and on the day somebody has to walk from "Team 7" to whatever the team called itself.

Four things the design had to get right, each pinned by a test:

- **Concurrency.** The claim is one statement, `FOR UPDATE SKIP LOCKED`, so two teams confirming
  in the same millisecond take different slots instead of one overwriting the other's placement.
- **Exhaustion.** They said 40, 50 or 60 teams. If 60 arrive against 50 slots the registration
  still succeeds and the team is simply unplaced. Refusing the fifty-first registration would be
  the worst failure available; an unplaced team is a line on a readiness panel.
- **Name collisions.** An unclaimed slot is excluded from the team-name check. "Team 7" is a label
  on a door, not a team anybody has, and it must not block a team that wants that name.
- **Idempotence.** Provisioning keys on the slot label, so a second file adding 51 to 60 leaves
  1 to 50 alone.

### What the requirement changed under me, twice

Mid-build they added that rooms hold more than one team. A unique index enforced the opposite, so
migration 096 removed it and published `v_roster_room_load` instead: teams, people and whether
that exceeds what the room seats. It reports and refuses nothing — a refusal on the morning
because a hall is one seat over would be obstructive, and the person assigning can see the room.
`room.capacity` already existed and meant nothing to any code; now it does.

Then they asked for the deadline in the registration email. The deadline already existed as data
on the submission window and the reminder email interpolated it, so migration 098 adds
`{{deadline}}` to the code email and the coach notice and renders it from the window the system
enforces. A date typed into a template is a promise nothing keeps.

### Three defects found while doing it

**The submission window could not be corrected.** `openWindow` refused while one was open and told
the operator to lock it first — which is permanent and would end the event's submissions. Meanwhile
the Intake page offered a "Change the window" button the API would not honour. An unlocked window
is now changed in place, audited with the before and after; a locked one still cannot move.

Worse, the window in this database still closed on the evening of 2 October, left over from
calibration. No team could have submitted on the Sunday. It now closes Sunday 4 October at 09:00
Eastern.

**The test suite inherited the developer's mail configuration and sent real email.** With
`MAIL_PROVIDER=smtp` in a local `.env`, the suite booted the SMTP adapter and transmitted: a test
asserting a message was PREPARED found it SENT, because it had just been delivered to a live
mailbox. The integration setup and the Playwright servers now force the recording adapter, the
same fix the model provider needed earlier.

### Who is told what

Every member gets the submission code, because any of them may be at the keyboard at 11pm and a
code held only by somebody asleep is a code the team lacks. The coach gets the team, the room and
the roster and **not** the code (migration 097): the code is the team's identity, and a coach who
can submit as the team breaks the one fact the evaluation rests on. That is a template change if
the organisers decide otherwise, and it was flagged to them rather than assumed.

### Verification

`pnpm verify` clean: **2,805 tests across 188 files**. Playwright **271 of 271**. 37 of those
tests are new: 15 integration on the claim, 7 on the routes, 10 on the panel, 5 journeys.
