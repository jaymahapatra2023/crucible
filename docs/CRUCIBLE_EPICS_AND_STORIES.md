# Crucible — Hackathon Submission Triage

**Epics, stories and architectural basis**

| | |
|---|---|
| **Document** | Build plan — epics and stories |
| **Version** | 1.0 |
| **Date** | 2026-09-22 |
| **Status** | Draft for engineering review |
| **Scope** | Evaluate 40–50 hackathon submissions across 2 challenges; produce a ranked top 20 for human confirmation |

> **Name.** "Crucible" is a working name — a vessel in which things are tested under heat.
> Rename the folder and the package scope freely; nothing in this plan depends on it.

---

# Part I — Architectural basis

Everything in Part III derives from findings in this part. Each finding was verified against
live source, not assumed. Where a conclusion rests on an unverified assumption, it says so.

## I.1 What was verified

Read directly in the upstream reference implementation's API source tree (`apps/api/src`):

| File | Lines | What it establishes |
|---|---|---|
| `services/discoveryService.ts` | 2092 | `scanRepository()` at :1893 — takes `repo_url`, clones, budgets files, chunks, emits structured findings |
| `services/discoveryJobService.ts` | 1190 | Stage pipeline: GATHERING → SCANNING → ENRICHING → PRINCIPLES → STANDARDS → SCORING → LINEAGE |
| `services/scoringEngine.ts` | 495 | `DEFAULT_WEIGHTS`, 9 dimensions, `INVEST/TOLERATE/MIGRATE/RETIRE` output |
| `services/scoringDimensionService.ts` | 717 | `buildDimensionsFromDB()` — sources every dimension from portfolio tables |
| `services/principlesAdoptionService.ts` | 298 | LLM principle evaluator, 0–4 maturity, 9 pillars |
| `services/standardsComplianceService.ts` | 293 | LLM standards evaluator, COMPLIANT/PARTIAL/NON_COMPLIANT |
| `services/claudeCliRunner.ts` | 372 | CLI fallback path for LLM calls |
| `services/llmGatewayService.ts` | 891 | Gateway with retry/fallback ladder, cost caps, DB logging |
| `services/re/reVcsHelpers.ts` | 429 | `SKIP_EXTENSIONS`, `SKIP_DIRS`, `SKIP_FILENAMES` |
| `db/migrations/029_architecture_principles.sql` | — | `arch_principle`, `app_principle_adoption`, `v_app_principle_summary` |

## I.2 The five findings that shape the build

### F1 — The scanner is extractable with low coupling

`discoveryService.ts` module-level imports are Node built-ins (`child_process`, `crypto`,
`async_hooks`, `fs`, `path`) plus exactly three internal things:

- `extractJsonObject` from the upstream adapters package — a JSON-from-LLM-text extractor
- `SKIP_EXTENSIONS / SKIP_DIRS / SKIP_FILENAMES` from `./re/reVcsHelpers`
- `DEFAULT_MODEL` from `./llmDefaults` (11 lines)

**There is no database import at module scope.** The only DB coupling inside `scanRepository`
is a data-guard branch gated on `input.plan_id`. Omit `plan_id` and the branch is unreachable.

**Consequence:** E04 is a lift-and-vendor, not a rewrite. This is the single biggest
de-risking finding in the assessment.

### F2 — The scoring engine must be replaced, not adapted

`DEFAULT_WEIGHTS` and their sources in `buildDimensionsFromDB`:

| Dimension | Weight | Source table | Exists for a hackathon repo |
|---|---:|---|---|
| businessValue | 0.22 | `application.business_criticality`, active users | No |
| technicalHealth | 0.17 | scan-derived | **Yes** |
| riskExposure | 0.17 | `application_risk`, `app_incident` | No |
| functionalCoverage | 0.10 | capability mappings | No |
| architectureScore | 0.08 | deployment type + principles + standards | Partly |
| vendorRisk | 0.07 | `technology.end_of_life_date` | No |
| costEfficiency | 0.07 | `application_cost` | No |
| devopsMaturity | 0.07 | deployment-environment lookup | No |
| maintainability | 0.05 | derived; zeroed by `normalizeWeights()` | n/a |

**70% of composite weight has no input.** Defaults are not neutral — they are
portfolio-calibrated constants (`CRITICALITY_BASE` → 55, `functionalCoverage` → 65). Output
shape is also wrong: a disposition against absolute thresholds (70/55/40), where we need a
cohort-relative ranking.

**Consequence:** E06 and E07 are new code. Do not import `scoringEngine.ts`.

### F3 — The principle and standards evaluators do not read code

`ADOPTION_PROMPT` (`principlesAdoptionService.ts:48`) receives: app name, description,
`infrastructure_type`, a tech-stack **list**, an integrations **list**, security findings, and
`artifact_content` truncated to 10 000 chars. `COMPLIANCE_PROMPT` is the same shape at 12 000
chars. Both are second-order passes over the scanner's summary.

Their contribution to the composite is also tiny: principles are 35% of `architectureScore`
which is 8% of composite = **2.8%**; standards are 25% × 8% = **2%**.

**Consequence:** reuse the *prompt structure, result shape and 0–4 anchoring* — which are
sound — but rewrite the context builder to pass real source. Raise the combined weight from
~5% to 20%.

### F4 — The rubric must be data, versioned and frozen

Challenges are uploaded; the app proposes criteria; the committee approves. This removes the
committee from the critical path (the scorer depends on the rubric *schema*, fixed, not the
rubric *content*, not fixed) and makes the service reusable across events.

It is only safe with three invariants:

1. Generated criteria are never used unreviewed.
2. The model proposes criteria; **people set weights**.
3. The rubric is frozen and content-hashed before the first score; every score record cites
   the version it ran under.

### F5 — Ranking is global; comparability is engineered, not assumed

Decision (owner, 2026-09-22): **a single top 20 across both challenges.**

This is made valid by where challenge-specific content sits: 70% of the rubric is
challenge-agnostic. Only challenge fidelity (30%) is generated per brief, and that dimension
is **normalised within its own challenge cohort** before entering the composite — so it reads
"how well did you solve the challenge you chose", which means the same thing on both tracks.

Guards: cohort below ~15 falls back to absolute scoring with human review; the final 20 always
reports its challenge split.

## I.3 The governance constraint

**LLM scoring is non-deterministic and we are eliminating ~30 teams with it.** Chunking
compounds this — a file budget silently decides which parts of a submission were read at all.

Four commitments follow, and they are requirements, not preferences:

- **Shortlist, don't decide.** Rank to ~25; humans confirm the final 20.
- **Every score carries evidence** as a file-and-line reference. A score without one is
  unusable in an appeal.
- **Score twice; flag disagreement.** Any team whose two runs straddle the cut line routes to
  human review automatically.
- **Publish the rubric before submissions open.**

## I.4 Security constraint — untrusted code execution

**E05 executes build commands from 50 untrusted repositories.** This is the highest-severity
risk in the system and it is easy to under-rate because it looks like plumbing.

Non-negotiable controls: ephemeral container per probe; no host filesystem mount; network
egress denied by default (or allow-listed to package registries only); CPU/memory/PID caps;
hard wall-clock timeout; no credentials, tokens or env of the host process reachable from the
container; logs captured to a size cap.

## I.5 Reuse inventory

| Source | Disposition | Notes |
|---|---|---|
| `discoveryService.ts` → `scanRepository`, `gatherFilesFromPath`, `getRepoStats`, `computeFilesAnalyzed`, `getCommitSha`, `DEPTH_PROFILES`, `mergeDiscoveryResults`, `chunkArray` | **COPY** | Drop `plan_id`, data-guard branch, notification hooks |
| `re/reVcsHelpers.ts` skip-lists | **COPY** | Constants only |
| `extractJsonObject` | **REIMPLEMENT** | ~30 lines; avoids an external package dep |
| `principlesAdoptionService.ts` prompt + result shape | **ADAPT** | Rewrite context builder to pass source code |
| `standardsComplianceService.ts` prompt + result shape | **ADAPT** | Same |
| `claudeCliRunner.ts` | **REFERENCE** | Borrow the process/abort handling pattern |
| `llmGatewayService.ts` | **DO NOT COPY** | 891 lines of gateway concerns we don't need; write a thin client, borrow the retry/fallback *pattern* |
| `scoringEngine.ts` | **DO NOT COPY** | See F2 |
| `scoringDimensionService.ts` | **DO NOT COPY** | Reads portfolio tables we will not have |
| `discoveryJobService.ts` | **REFERENCE** | Borrow the stage-result ledger pattern for E10 |
| `arch_principle` seed rows (9 pillars) | **COPY (data)** | Only if the committee adopts them — see OD-2 |

---

# Part II — Target architecture

## II.1 System shape

```
crucible/
├── apps/
│   ├── api/                  Fastify + TypeScript. All endpoints, orchestration.
│   └── web/                  React + Vite. Review and shortlist UI.
├── packages/
│   ├── scanner/              Extracted repository scanner (E04). No DB, no auth.
│   ├── rubric/               Rubric schema, synthesis, quality gate (E02).
│   ├── scoring/              Criterion scoring, normalisation, composite (E06/E07).
│   └── prober/               Sandboxed build-and-run harness (E05).
├── db/
│   ├── migrations/
│   └── seed/
└── docs/
```

**Why a workspace and not one service:** `packages/scanner` and `packages/prober` must be
independently testable against real repositories without booting the API or the database.
`packages/rubric` holds the schema that everything else compiles against — keeping it separate
makes the contract explicit.

## II.2 Data model

```
challenge          (challenge_id, name, slug, brief_uri, created_at)
challenge_artifact (artifact_id, challenge_id, kind, uri, extracted_text, bytes)

rubric             (rubric_id, challenge_id, version, content_hash, status,
                    generated_at, approved_by, approved_at, frozen_at, published_at)
                    status ∈ DRAFT | IN_REVIEW | APPROVED | FROZEN | SUPERSEDED
rubric_criterion   (criterion_id, rubric_id, dimension, name, description, weight,
                    evidence_spec, anchor_0..anchor_4, source_ref, sort_order)
                    dimension ∈ CHALLENGE_FIDELITY | ENGINEERING_QUALITY
                                | PRINCIPLES_STANDARDS | RUNS | ORIGINALITY

submission         (submission_id, team_name, challenge_id, repo_url, build_method,
                    build_command, artifact_urls[], submitted_at, validation_status,
                    validation_detail)
                    build_method ∈ DOCKERFILE | COMMAND
                    validation_status ∈ PENDING | VALID | UNREACHABLE | PRIVATE | REJECTED

scan               (scan_id, submission_id, commit_sha, head_committed_at, files_analyzed,
                    files_total, code_metrics, raw_result, depth, started_at, finished_at,
                    status, error)
provenance         (submission_id, first_commit_at, last_commit_at, commits_in_window,
                    commits_out_of_window, distinct_authors, largest_single_commit_pct)

build_probe        (probe_id, submission_id, method, exit_code, duration_ms, log_uri,
                    timed_out, resource_exceeded, ran_at)

score_run          (run_id, run_index, rubric_versions jsonb, model, started_at,
                    finished_at, status)          -- run_index ∈ 1 | 2
criterion_score    (id, run_id, submission_id, criterion_id, raw_score, confidence,
                    rationale, evidence jsonb[], scored_at)
                    evidence element: { path, line_start, line_end, excerpt }
dimension_score    (id, run_id, submission_id, dimension, score, data_quality)
composite_score    (id, run_id, submission_id, fidelity_raw, fidelity_normalised,
                    cohort_size, composite, rank_global, rank_in_challenge)

variance_flag      (id, submission_id, run_a, run_b, delta, straddles_cut, flagged_at)
review_decision    (id, submission_id, decision, reason, decided_by, decided_at)
                    decision ∈ SHORTLIST | EXCLUDE | HOLD
audit_event        (event_id, actor, action, subject_type, subject_id, payload, at)
```

## II.3 The rubric contract

This is the interface every later component compiles against. **Fix it first (E02-S03);
everything else is unblocked the moment it is settled.**

```jsonc
{
  "rubric_id": "rb_7f3a…",
  "challenge_id": "ch_alpha",
  "version": 3,
  "content_hash": "sha256:…",          // over the normalised criteria array
  "status": "FROZEN",
  "criteria": [
    {
      "criterion_id": "cr_01",
      "dimension": "CHALLENGE_FIDELITY",
      "name": "Ingests the provided telemetry feed",
      "description": "…",
      "weight": 0.12,                   // weights sum to 1.0 within a dimension
      "evidence_spec": "A reader can point to code that connects to the feed and parses its schema.",
      "anchors": {
        "0": "No evidence the feed is consulted.",
        "1": "Referenced in docs or config only.",
        "2": "Connection code present but unused or non-functional.",
        "3": "Feed consumed and parsed for the main path.",
        "4": "Consumed, parsed, validated, with failure handling."
      },
      "source_ref": "brief §2.1, para 3"
    }
  ]
}
```

**Invariants**

- `weight` sums to 1.0 within each dimension; dimension weights sum to 1.0 across the rubric.
- `evidence_spec` is mandatory and must describe something observable in a repository.
- `source_ref` is mandatory for `CHALLENGE_FIDELITY` criteria (traceability to the brief).
- Once `status = FROZEN`, the row is immutable. A change creates a new `version`.

## II.4 Default dimension weights

The starting template the generator fills in and the committee adjusts.

| Dimension | Weight | Nature |
|---|---:|---|
| Challenge fidelity | 30% | Generated per challenge; normalised within cohort |
| Engineering quality | 25% | Challenge-agnostic |
| Principles & standards | 20% | Challenge-agnostic |
| Runs (build & execute) | 15% | **Objective** — not model-scored |
| Originality & completeness | 10% | Challenge-agnostic |

---

# Part III — Epics and stories

**Conventions.** `M` = must-have for the event. `S` = should-have. `C` = could-have.
Sizes are ideal engineer-days. `→` denotes a dependency.

---

## E01 — Foundation

**Goal.** A workspace, a database, a job ledger and an LLM client that the other ten epics
build on.
**Depends on:** nothing. **Size:** 4–6 d.

### E01-S01 — Workspace scaffold · M · 1d
*As an engineer, I want a pnpm workspace with api, web and four packages, so that each unit is
independently buildable and testable.*

**Acceptance**
1. `pnpm -r build` succeeds from a clean clone.
2. `packages/scanner` builds and its tests run with no database and no API running.
3. TypeScript strict mode on; CI fails on type error.
4. A single `pnpm dev` starts api and web together.

### E01-S02 — Database and migration runner · M · 1d
*As an engineer, I want forward-only, idempotent migrations, so that schema state is
reproducible in every environment.*

**Acceptance**
1. Migrations are numbered, applied in order, recorded in `schema_migrations`.
2. Re-running `migrate` on an up-to-date database is a no-op and exits 0.
3. Every migration is idempotent (`IF NOT EXISTS` / guarded `ALTER`).
4. A `db:reset` path exists for local development only and refuses to run against a non-local
   host.

### E01-S03 — Configuration and secrets · M · 0.5d
*As an operator, I want all configuration to come from environment with fail-fast validation,
so that a misconfigured deployment stops rather than misbehaves.*

**Acceptance**
1. Required variables are validated at boot; a missing one aborts with a named error.
2. No secret is ever logged, including inside error payloads.
3. Model name, concurrency limit and cost ceiling are configuration, not constants.

### E01-S04 — Thin LLM client · M · 1.5d
*As an engineer, I want a small typed LLM client with retry and structured-output parsing, so
that scoring components do not each reinvent it.*

**Acceptance**
1. `callModel({ callKey, system, user, schema })` returns parsed, schema-validated output.
2. Retries on transient failure with backoff; a hard cap on attempts.
3. Malformed JSON is repaired once via an extraction pass, then fails loudly.
4. Every call records: `callKey`, tokens in/out, latency, attempt count, cost estimate.
5. `callKey` is mandatory and appears in every log line.

> Borrow the retry/fallback **pattern** from `llmGatewayService.ts`. Do not copy its 891 lines
> — its cost-cap, DB-logging and provider-parity concerns are not ours.

### E01-S05 — Run ledger · M · 1d
*As an operator, I want every long-running operation to record per-stage outcomes, so that a
failed batch can be diagnosed and resumed rather than restarted.*

**Acceptance**
1. A `run` row with per-stage `ok | failed | skipped | warning` plus message and timing.
2. Stage results survive process restart.
3. `GET /runs/:id` returns current state without reading logs.

> Pattern reference: `discoveryJobService.ts` `stageResult()`.

---

## E02 — Challenge intake and rubric synthesis

**Goal.** Upload a brief and its artifacts; produce reviewed, approved, frozen, versioned
criteria.
**Depends on:** E01. **Size:** 8–11 d. **Critical path.**

### E02-S03 — Rubric schema · M · 1d → *do this first*
*As an engineer, I want the rubric contract fixed and published as a typed package, so that
scoring can be built before any real rubric exists.*

**Acceptance**
1. Types and a runtime validator live in `packages/rubric`, exported.
2. Validator enforces: weights sum to 1.0 per dimension; `evidence_spec` non-empty; five
   anchors present; `source_ref` present for `CHALLENGE_FIDELITY`.
3. `hashRubric(criteria)` is stable across key order and whitespace.
4. Fixture rubrics for both challenges exist for downstream tests.

**Why first:** this single story unblocks E06 and E07 without waiting on real briefs.

### E02-S01 — Challenge upload · M · 1.5d
*As an organiser, I want to upload a brief and supporting artifacts, so that the rubric can be
generated from them.*

**Acceptance**
1. Accepts PDF, DOCX, Markdown and plain text; multiple artifacts per challenge.
2. Per-file size cap enforced with a clear message naming the limit and the file.
3. Uploaded files are retained and re-downloadable — the rubric must remain traceable to its
   source after the event.
4. A challenge can be created, listed, and soft-deleted while `DRAFT`.

### E02-S02 — Document extraction · M · 1.5d
*As the generator, I want artifact text extracted with structure preserved, so that
`source_ref` can name a section.*

**Acceptance**
1. Text extracted per file with section or page markers retained.
2. Extraction failure is surfaced per-file, not silently skipped, and does not fail the batch.
3. Extracted text is persisted (`challenge_artifact.extracted_text`) so generation is
   repeatable without re-parsing.

### E02-S04 — Criteria generator · M · 2d
*As an organiser, I want the app to propose scoring criteria from the brief, so that I review
a draft rather than author from scratch.*

**Acceptance**
1. Produces 5–10 `CHALLENGE_FIDELITY` criteria per challenge.
2. Each carries: name, description, `evidence_spec`, five anchors, `source_ref`.
3. Proposed weights are **unset** — the generator does not assign them (see E02-S06).
4. Output validates against the E02-S03 schema before persisting.
5. Re-running produces a new `version`; it never mutates an existing one.

### E02-S05 — Quality gate · M · 1.5d
*As an organiser, I want unscoreable criteria rejected before I see them, so that review time
is spent on judgement rather than on cleanup.*

**Acceptance**
1. A criterion is rejected when `evidence_spec` does not describe something locatable in a
   repository.
2. Rejected criteria are regenerated once; persistent failures surface to the reviewer marked
   `NEEDS_REWRITE` rather than being dropped.
3. Anchors must be materially distinct — identical or near-identical adjacent anchors fail.
4. The gate's decisions are logged with reasons and are visible in review.

> Known failure mode: "innovative solution", "good architecture". These pass a naive check and
> fail in practice. Test the gate against a deliberately vague fixture.

### E02-S06 — Review, edit and weight · M · 2d
*As an organiser, I want to edit criteria and set weights before approving, so that the rubric
reflects what this hackathon is actually for.*

**Acceptance**
1. Criteria can be edited, reordered, removed and added by hand.
2. Weights are set by a human; the UI shows the running total and blocks approval until each
   dimension sums to 1.0.
3. Each criterion shows its `source_ref` with a link to the extracted brief passage.
4. Quality-gate warnings are visible and must be explicitly acknowledged to approve.

### E02-S07 — Approve, freeze, version · M · 1d
*As an organiser, I want an approved rubric frozen and hashed, so that every score can name
the standard it was judged by.*

**Acceptance**
1. Approval records actor and timestamp; transitions `APPROVED` → `FROZEN`.
2. A `FROZEN` rubric is immutable — writes are refused at the database level, not only in the
   application.
3. Editing a frozen rubric creates a new `version` and marks the previous `SUPERSEDED`.
4. `content_hash` is computed at freeze and stored.
5. **Scoring refuses to start against a rubric that is not `FROZEN`.**

### E02-S08 — Publish to teams · M · 0.5d
*As an organiser, I want to export the frozen rubric in a readable form, so that it can be
published before submissions open.*

**Acceptance**
1. Export renders criteria, weights and anchors as Markdown and HTML.
2. Export carries version and hash.
3. Publication timestamp is recorded on the rubric row.

---

## E03 — Submission intake

**Goal.** Collect and validate 50 submissions so that evaluation night has no surprises.
**Depends on:** E01, E02-S07. **Size:** 4–5 d.

### E03-S01 — Submission form · M · 1.5d
*As a team, I want to submit our entry with the information the evaluator needs, so that it can
be scored without follow-up.*

**Acceptance**
1. Captures: team name, contact, challenge selection, public repo URL, build method,
   build command or Dockerfile path, optional artifact URLs.
2. Challenge selection is required and immutable after the window closes.
3. One submission per team per challenge; resubmission supersedes and is versioned.

### E03-S02 — Repo validation at submit time · M · 1.5d
*As an organiser, I want an unreachable repository caught at submission, so that it is a
support conversation on the day rather than an incident on evaluation night.*

**Acceptance**
1. On submit: URL is well-formed, host is allow-listed, and a shallow clone succeeds.
2. Failure returns a specific reason — private, not found, auth required, timeout — not a
   generic error.
3. `validation_status` is persisted and shown to the team.
4. Validation re-runs on a schedule until the window closes; a repo that goes private after
   submission is flagged.

### E03-S03 — Build declaration · M · 0.5d
*As an organiser, I want each team to declare how their project builds, so that the prober does
not have to guess.*

**Acceptance**
1. Team declares `DOCKERFILE` (with path) or `COMMAND` (with a single command string).
2. Declared Dockerfile path is confirmed to exist during E03-S02 validation.
3. The requirement is stated in the published rules — see OD-3.

### E03-S04 — Window enforcement and lock · M · 0.5d
*As an organiser, I want submissions frozen at the deadline, so that the evaluated artifact is
the submitted one.*

**Acceptance**
1. After the deadline, writes are refused with a clear message.
2. At lock, the current `HEAD` SHA of every submission is recorded (see E04-S03).
3. Lock time and actor are audited.

### E03-S05 — Intake dashboard · S · 1d
*As an organiser, I want to see intake status at a glance, so that I can chase problems before
the deadline.*

**Acceptance**
1. Counts by challenge and by `validation_status`, each a real backend count.
2. Failing submissions are listed with reason and contact.
3. Export to CSV.

---

## E04 — Repository scanner

**Goal.** Port the existing scanner into a standalone package with no platform coupling.
**Depends on:** E01. **Size:** 5–7 d. **Can start immediately — no dependency on the briefs.**

### E04-S01 — Extract scanner package · M · 2.5d
*As an engineer, I want `scanRepository` running inside `packages/scanner` with no database and
no auth, so that it can be tested and reused independently.*

**Acceptance**
1. Copy from `discoveryService.ts`: `scanRepository`, `gatherFilesFromPath`, `getRepoStats`,
   `computeFilesAnalyzed`, `getCommitSha`, `mergeDiscoveryResults`, `chunkArray`,
   `DEPTH_PROFILES`, and the result interfaces.
2. `plan_id` is removed from `ScanInput`; the data-guard branch is deleted, not disabled.
3. Notification hooks removed.
4. The package imports nothing from the source platform and has no `pg` dependency.
5. `packages/scanner` tests run green with no database.

### E04-S02 — Vendor helpers · M · 0.5d
*As an engineer, I want the scanner's few internal dependencies vendored, so that the package
stands alone.*

**Acceptance**
1. `SKIP_EXTENSIONS`, `SKIP_DIRS`, `SKIP_FILENAMES` copied into the package.
2. `extractJsonObject` reimplemented with its own unit tests covering fenced blocks, leading
   prose and truncated output.
3. `DEFAULT_MODEL` becomes configuration, not a constant.

### E04-S03 — Clone and commit snapshot · M · 1d
*As an evaluator, I want the exact evaluated commit recorded, so that a re-run and an appeal
refer to the same code.*

**Acceptance**
1. Shallow clone into an ephemeral working directory; always cleaned up, including on failure.
2. `commit_sha` and its committed timestamp persisted on `scan`.
3. Re-scanning the same submission at the same SHA is detected and skipped unless forced.

### E04-S04 — Depth profile and file budget · M · 0.5d
*As an operator, I want the file budget explicit and recorded, so that coverage differences
between submissions are visible rather than hidden.*

**Acceptance**
1. Depth is configurable per run; default chosen from E11 measurement.
2. `files_analyzed` and `files_total` are both persisted.
3. When the budget truncates a repository, that fact is surfaced in the UI (E08-S06) — not
   silently absorbed.

### E04-S05 — Scan persistence · M · 0.5d
*As an engineer, I want the raw scan result stored verbatim, so that scoring can be re-run
without re-scanning.*

**Acceptance**
1. `raw_result` stored as received; `code_metrics` extracted to typed columns.
2. Scoring reads persisted scan output; it never triggers a scan implicitly.

### E04-S06 — Provenance analysis · S · 1.5d
*As an organiser, I want to know whether the work was done during the event, so that
out-of-window work can be reviewed rather than silently rewarded.*

**Acceptance**
1. From git history: first/last commit time, commits inside vs outside the event window,
   distinct authors, largest single commit as a share of total additions.
2. A submission whose work is substantially out-of-window is flagged for review — **flagged,
   never auto-excluded**.
3. Thresholds are configuration.
4. Shallow clone depth is sufficient for this analysis, or the clone strategy is adjusted and
   the cost noted.

---

## E05 — Build and run prober

**Goal.** Determine objectively whether a submission builds and runs, inside a sandbox that
assumes the code is hostile.
**Depends on:** E01, E03-S03. **Size:** 4–6 d. **Highest security risk in the system.**

### E05-S01 — Sandbox harness · M · 2d
*As an operator, I want every probe to run in a disposable, constrained container, so that
untrusted submission code cannot affect the host or reach anything it should not.*

**Acceptance**
1. One ephemeral container per probe, destroyed afterwards regardless of outcome.
2. No host filesystem mount; the repository is copied in.
3. Network egress denied by default; if a build needs registries, egress is allow-listed to
   those hosts only and the allowance is recorded on the probe.
4. CPU, memory and PID limits enforced; hard wall-clock timeout.
5. No host environment variables, credentials or tokens are reachable inside the container.
6. A deliberately hostile fixture (attempts network callout, fork bomb, host path write) is
   contained by all of the above, and this is a test.

### E05-S02 — Dockerfile path · M · 1d
*As an evaluator, I want Dockerfile submissions built and started, so that the result reflects
the team's own definition of running.*

**Acceptance**
1. Build from the declared path; capture exit code, duration and logs.
2. On successful build, start the container and record whether it stays up for a configured
   settle period.
3. Logs truncated to a size cap with truncation stated.

### E05-S03 — Command path · M · 0.5d
*As an evaluator, I want command submissions run in a standard base image, so that teams
without Docker are not disadvantaged.*

**Acceptance**
1. Command executed in a base image chosen by detected language.
2. Same capture and caps as E05-S02.
3. When no base image matches the stack, the probe records `UNSUPPORTED_STACK` rather than
   failing the submission.

### E05-S04 — Probe result and scoring input · M · 0.5d
*As the scorer, I want a clean binary-plus-detail result, so that the Runs dimension is
objective.*

**Acceptance**
1. `build_probe` persists method, exit code, duration, timeout flag, resource-exceeded flag,
   log reference.
2. Dimension score derives deterministically from the probe: builds and stays up, builds only,
   fails to build, unsupported.
3. **No model call participates in this dimension.**

### E05-S05 — Reviewer log access · S · 0.5d
*As a reviewer, I want to read the build log for a failing submission, so that I can tell a
broken submission from a broken prober.*

**Acceptance**
1. Logs viewable from the team detail view (E08-S02).
2. Access is audited.

---

## E06 — Rubric scoring engine

**Goal.** Score each submission against the frozen rubric, with evidence, twice.
**Depends on:** E02-S03, E04-S05. **Size:** 8–11 d.

### E06-S01 — Code-bearing context builder · M · 2d
*As the scorer, I want relevant source passed to the model rather than a summary, so that
criteria about how something is built can actually be judged.*

**Acceptance**
1. Builds context from persisted scan output **plus selected source excerpts** with paths and
   line numbers.
2. Selection is driven by each criterion's `evidence_spec`, not a fixed file list.
3. Context size is budgeted and the budget recorded per call.
4. When a criterion's evidence cannot be located, that is an explicit `insufficient_evidence`
   outcome — **not** a low score.

> This story is the direct fix for finding F3 and is the single largest quality lever in the
> system.

### E06-S02 — Criterion scorer · M · 2d
*As an evaluator, I want each criterion scored 0–4 with rationale and evidence, so that every
number is traceable.*

**Acceptance**
1. Per criterion: `raw_score` 0–4, `confidence` 0–100, `rationale`, `evidence[]` with
   `{path, line_start, line_end, excerpt}`.
2. Anchors from the rubric are supplied verbatim in the prompt.
3. Output schema-validated; a malformed response retries once then records `SCORING_FAILED`
   for that criterion rather than defaulting to zero.
4. Every score row records `rubric_id` and `version`.

> Adapt the prompt structure and 0–4 anchoring from `principlesAdoptionService.ts` — the shape
> is sound; only the context changes.

### E06-S03 — Principles and standards evaluators · M · 2d
*As an evaluator, I want principles and standards assessed from real code, so that the 20%
they carry is earned.*

**Acceptance**
1. Both evaluators consume the E06-S01 context, not a tech-stack list.
2. Principles retain the 0–4 maturity model; standards retain compliant/partial/non-compliant.
3. Both produce evidence in the same shape as E06-S02.
4. If the committee adopts the nine pillars, the seed data is imported; otherwise the
   committee's own list is loaded (see OD-2).

### E06-S04 — Engineering quality scorer · M · 1.5d
*As an evaluator, I want engineering quality scored from metrics and review together, so that
it reflects more than line counts.*

**Acceptance**
1. Consumes `code_metrics` from the scan plus a model review pass over selected source.
2. Produces the same evidence-bearing output shape.
3. Metric inputs are shown alongside the score in the UI.

### E06-S05 — Originality and completeness scorer · S · 1d
*As an evaluator, I want an originality signal, so that scaffold-only submissions are visible.*

**Acceptance**
1. Considers boilerplate share, template detection and provenance signals from E04-S06.
2. Explicitly marked as **advisory**, and carries the lowest weight.
3. Never the sole reason a submission falls below the cut — enforced in E07-S06 reporting.

### E06-S06 — Double run and variance · M · 1.5d
*As an organiser, I want each submission scored twice with disagreement flagged, so that
borderline cases reach a human.*

**Acceptance**
1. Two independent `score_run` rows per cohort, `run_index` 1 and 2.
2. Composite delta computed per submission.
3. Any submission whose two composites straddle the cut line is flagged `straddles_cut`.
4. Delta exceeding a configured threshold is flagged regardless of position.
5. Flags are surfaced in E08-S03 and cannot be dismissed without a recorded reason.

---

## E07 — Composite scoring and ranking

**Goal.** Turn criterion scores into a defensible global top 20.
**Depends on:** E06. **Size:** 4–5 d.

### E07-S01 — Dimension aggregation · M · 1d
*As an evaluator, I want criterion scores rolled into dimension scores, so that the composite
is explainable.*

**Acceptance**
1. Criterion scores weighted within dimension per the frozen rubric.
2. 0–4 scale mapped to 0–100 by a single documented transform.
3. `insufficient_evidence` and `SCORING_FAILED` are excluded from the denominator and the
   affected dimension is marked `PARTIAL`, never silently treated as zero.

### E07-S02 — Within-cohort fidelity normalisation · M · 1.5d
*As an organiser, I want challenge fidelity normalised inside its own cohort, so that the two
challenges can be ranked together honestly.*

**Acceptance**
1. Fidelity is converted to a within-challenge standing before entering the composite.
2. The transform is documented, deterministic and unit-tested on synthetic cohorts, including
   degenerate ones (all-equal scores, single team).
3. Both `fidelity_raw` and `fidelity_normalised` are persisted — the raw value must remain
   visible for appeals.
4. The other four dimensions are **not** normalised within challenge.

### E07-S03 — Cohort size guard · M · 0.5d
*As an organiser, I want thin cohorts handled explicitly, so that normalisation noise is not
mistaken for signal.*

**Acceptance**
1. Cohort size is computed and stored before scoring.
2. Below a configured floor (default 15), fidelity falls back to absolute scoring and every
   affected submission is flagged for human review.
3. The fallback is visible in the UI and in the export — never silent.

### E07-S04 — Composite and global rank · M · 1d
*As an organiser, I want one ranked list across both challenges, so that the strongest work
presents.*

**Acceptance**
1. Composite computed from dimension weights; `rank_global` and `rank_in_challenge` both
   stored.
2. Ties broken by a documented, deterministic rule; ties at the cut line are flagged.
3. The system produces a ranked list of ~25 for review — **it does not mark 20 as selected**.

### E07-S05 — Challenge split reporting · M · 0.5d
*As an organiser, I want the challenge breakdown of the shortlist, so that a lopsided result is
a visible decision rather than an accident.*

**Acceptance**
1. Top-N view always shows the split by challenge.
2. A split beyond a configured imbalance raises a non-blocking advisory.
3. Median composite per challenge is shown alongside, so difficulty imbalance is
   distinguishable from talent distribution.

### E07-S06 — Cut-line band · M · 0.5d
*As a reviewer, I want the teams near the boundary identified, so that human attention goes
where it changes outcomes.*

**Acceptance**
1. A configurable band around rank 20 is computed and labelled.
2. Every submission in the band is listed for mandatory review.
3. A submission whose position depends primarily on the advisory originality dimension is
   called out (per E06-S05).

---

## E08 — Review and shortlist UI

**Goal.** Let a small committee confirm a shortlist quickly and defensibly.
**Depends on:** E07. **Size:** 5–7 d.

### E08-S01 — Ranked table · M · 1.5d
*As a reviewer, I want the ranked field in one screen, so that I can work through it in order.*

**Acceptance**
1. Rank, team, challenge, composite, dimension breakdown, flags.
2. Sort and filter by challenge, flag and dimension.
3. The cut-line band is visually distinct.
4. Counts are real backend counts, never array lengths.

### E08-S02 — Team detail and evidence · M · 2d
*As a reviewer, I want to see why a team scored as it did, so that I can confirm or overturn
with reason.*

**Acceptance**
1. Per criterion: score, anchor text matched, rationale, evidence with path and line numbers.
2. Evidence excerpts are shown inline; the repository link is present.
3. Build-probe result and log link.
4. Provenance summary from E04-S06.
5. Both runs' scores shown side by side where they differ.

### E08-S03 — Flags and guards · M · 1d
*As a reviewer, I want every automated caveat surfaced, so that nothing silently shapes the
outcome.*

**Acceptance**
1. Flags shown: variance, straddles cut, cohort fallback, truncated scan, insufficient
   evidence, unsupported stack, provenance.
2. Each states what it means in plain language, not a code.
3. Dismissing a flag requires a recorded reason.

### E08-S04 — Override with reason · M · 1d
*As an organiser, I want to include or exclude a team by hand with a recorded reason, so that
the final decision is ours and is documented.*

**Acceptance**
1. `SHORTLIST | EXCLUDE | HOLD` with a mandatory free-text reason.
2. Actor and timestamp recorded; overrides are immutable once the shortlist is finalised.
3. An overridden team displays the override and its reason wherever it appears.

### E08-S05 — Finalise and export · M · 1d
*As an organiser, I want to lock the shortlist and export it, so that the outcome is fixed and
communicable.*

**Acceptance**
1. Finalise locks decisions and records the rubric versions in force.
2. Export includes rank, composite, dimensions, flags, overrides and reasons.
3. Finalising is refused while any mandatory-review item in the cut band is unreviewed.

### E08-S06 — Data honesty · M · 0.5d
*As a reviewer, I want to trust what the screen says, so that I do not draw conclusions from a
partial fetch.*

**Acceptance**
1. Totals are backend counts; bounded fetches state "showing X of Y".
2. A failed fetch is visually distinct from an empty result.
3. Truncated scans and partial dimensions are labelled at the point of display.

---

## E09 — Governance, evidence and audit

**Goal.** Make every outcome explainable months later.
**Depends on:** E01. **Size:** 3–4 d. **Cross-cutting — implement alongside, not after.**

### E09-S01 — Audit log · M · 1d
*As an organiser, I want every consequential action recorded, so that the process can be
reconstructed.*

**Acceptance**
1. Recorded: rubric generated/edited/approved/frozen/published; submission created/validated/
   locked; run started/finished; score written; flag dismissed; override made; shortlist
   finalised.
2. Each event carries actor, timestamp, subject and payload.
3. Append-only; no update or delete path exists in the application.

### E09-S02 — Appeal packet · M · 1.5d
*As an organiser, I want a single export per team, so that an appeal is answered with a
document rather than a database query.*

**Acceptance**
1. Per team: rubric version and hash, every criterion score with rationale and evidence, probe
   result, provenance, flags, overrides, final rank.
2. Generated on demand, self-contained, readable without system access.
3. Generation is itself audited.

### E09-S03 — Access control · M · 1d
*As an organiser, I want roles enforced, so that only the committee can approve or override.*

**Acceptance**
1. Roles: `admin`, `organiser`, `reviewer`, `viewer`.
2. Approve, freeze, override and finalise are restricted to `organiser` and above.
3. Denials return a clear message and are audited.

### E09-S04 — Rubric publication record · S · 0.5d
*As an organiser, I want proof of what was published and when, so that "we were not told" is
answerable.*

**Acceptance**
1. Published rubric snapshot stored immutably with hash and timestamp.
2. Export reproduces exactly what teams received.

---

## E10 — Batch operations

**Goal.** Run 50 submissions through the pipeline reliably and within budget.
**Depends on:** E04, E05, E06. **Size:** 4–6 d.

### E10-S01 — Batch orchestration · M · 2d
*As an operator, I want one command to evaluate a cohort, so that the run is repeatable.*

**Acceptance**
1. A run processes all valid submissions for a challenge set through scan → probe → score.
2. Per-submission stage results recorded in the E01-S05 ledger.
3. Ordering is deterministic and recorded.

### E10-S02 — Concurrency and rate limiting · M · 1d
*As an operator, I want bounded parallelism, so that the run completes in reasonable time
without hitting provider limits.*

**Acceptance**
1. Concurrency is configurable and enforced across scan, probe and score independently.
2. Rate-limit responses back off and retry rather than failing the submission.
3. Wall-clock estimate is reported at run start from measured per-submission cost.

### E10-S03 — Cost budget · M · 1d
*As an organiser, I want token spend tracked against a ceiling, so that a runaway run stops
itself.*

**Acceptance**
1. Cost accumulated per run and per submission from E01-S04 records.
2. A configured ceiling pauses the run and alerts rather than continuing.
3. Projected total is shown from the first ten submissions onward.

### E10-S04 — Failure isolation and resume · M · 1.5d
*As an operator, I want one bad submission not to end the run, so that a batch completes
overnight without supervision.*

**Acceptance**
1. Any per-submission failure is captured, marked, and the run continues.
2. A run can resume: completed submissions are skipped unless forced.
3. Resume is idempotent — no duplicate score rows.
4. A run summary lists every failure with reason.

### E10-S05 — Progress visibility · S · 0.5d
*As an operator, I want live progress, so that I know whether an overnight run is healthy.*

**Acceptance**
1. Progress per stage with counts and current item.
2. Survives page reload.

---

## E11 — Calibration and dry run

**Goal.** Establish, before the event, whether this system is fit to eliminate teams.
**Depends on:** E07, E10. **Size:** 3–4 d. **Contains the go/no-go gate.**

### E11-S01 — Golden set · M · 1d
*As an organiser, I want a set of repositories with known relative quality, so that the scorer
can be checked against judgement.*

**Acceptance**
1. At least 8 repositories spanning clearly strong, middling and clearly weak.
2. Includes edge cases: scaffold-only, excellent code solving the wrong problem, fails to
   build, and a very large repository.
3. Hand-ranked independently by at least two people before any machine scoring.

### E11-S02 — Calibration report · M · 1d
*As an organiser, I want machine ranking compared against hand ranking, so that the go/no-go
decision rests on evidence.*

**Acceptance**
1. Reports rank correlation and every material disagreement with its evidence.
2. Reports run-to-run variance across the golden set.
3. Identifies which dimensions disagree most with human judgement.

### E11-S03 — Go / no-go gate · M · 0.5d
*As an organiser, I want an explicit decision point, so that an uncalibrated system is not used
by default.*

**Acceptance**
1. Criteria are written down **before** the report is produced.
2. The decision is recorded with rationale and actor.
3. **If the gate fails, the documented fallback is fully human judging** — the system may then
   be used for evidence gathering only, not for ranking.

### E11-S04 — Full-scale dry run · M · 1.5d
*As an operator, I want the whole pipeline exercised at 50-submission scale before the event,
so that failures happen in rehearsal.*

**Acceptance**
1. 50 synthetic or volunteer submissions processed end to end.
2. Measured: wall clock, token cost, failure count and causes.
3. Results feed the depth-profile and concurrency defaults.
4. Run at least one week before the real evaluation.

> **This is distinct from E11-S02.** Calibration tests whether the *scores* are right; the dry
> run tests whether the *machine* survives 50 real inputs.

---

## E12 — Repository discovery and the catalogue

**Goal.** Describe what each team actually built, and let the organisation write down the
principles and standards it is judged against — in the application, not in a migration.
**Depends on:** E04, E06, E08. **Size:** 5–6 d.

Discovery is the evidence base the evaluation reads from, not a parallel description beside it.
Two guards make that safe, and both are enforced rather than documented: discovery is
*additional* context and never a replacement for the code, and a concern it could not extract is
passed to an evaluator as absent — never as "none found". See `docs/adr/0003-repository-discovery.md`.

### E12-S01 — Concern-scoped extraction · L · 1.5d
*As a reviewer, I want a repository described concern by concern, so that one failed extractor
does not cost me the whole description.*

**Acceptance**
1. Seven concerns, each with its own registered call key, prompt, schema and config (P3.2).
2. Each concern selects its own evidence through the one context builder, driven by an evidence
   specification — never a fixed file list.
3. Each concern records its own outcome: FOUND, NONE_FOUND, INSUFFICIENT_EVIDENCE or FAILED.
4. A failed concern leaves the other six intact and the run COMPLETED.
5. Every finding carries a path and a line range, so a reviewer can check it.
6. Re-running supersedes rather than accumulating; the superseded run keeps its findings.

### E12-S02 — A gap is never a zero · M · 0.5d
*As a reviewer, I want to be able to tell "this team built none" from "we could not look", so
that I do not mark a team down for our failure.*

**Acceptance**
1. A tile shows a number only for FOUND and NONE_FOUND; otherwise it names the state.
2. An empty result is treated as meaningful only where an empty result is possible — an
   application can integrate with nothing; it cannot store nothing.
3. Unreadable concerns are named at the top of the page, with the reason and the statement that
   nothing is scored down for them.
4. `warn` is never a function of size: a small submission is not coloured as a fault.

### E12-S03 — Discovery feeds the evaluation · M · 0.5d
*As an organiser, I want the principles and standards evaluators to see what discovery found, so
that a principle about layering is assessed by someone who has been told where the layers are.*

**Acceptance**
1. The digest is passed alongside the source excerpts, never instead of them, and the prompt
   says so.
2. A concern discovery could not extract arrives as NOT DETERMINED, with an explicit instruction
   not to read it as an absence.
3. A submission with no discovery produces an explicit "none was run", not a blank section.
4. The prompt change is a new version; scores already taken keep the version they ran under.

### E12-S04 — Security observations, not vulnerabilities · M · 0.5d
*As a reviewer, I want security findings worded as things to check, because this system cannot
confirm a vulnerability.*

**Acceptance**
1. The field is `concern`, not `severity`, and no severity field exists in the schema.
2. Every observation carries what would make it benign, shown next to it.
3. An empty list is a legitimate outcome and is distinguished from an unreadable one.
4. Credential-shaped values are never echoed into an excerpt.

### E12-S05 — Documentation against code · S · 0.5d
*As a reviewer, I want to know where a claim in the README is not supported by the code, without
that reading as an accusation.*

**Acceptance**
1. Silence is not a conflict: absence of evidence is explicitly excluded.
2. Every conflict carries an innocent explanation, attached to the observation itself so no
   render path can drop it.
3. The UI frames conflicts as "worth checking" and says they are not findings of dishonesty.

### E12-S06 — Authoring principles and standards · L · 1d
*As a platform owner, I want to write down what the organisation requires, in the application.*

**Acceptance**
1. Principles and standards can be created, edited and retired through the UI.
2. Authoring is not adoption: a new entry is inactive and is not assessed against until adopted.
3. An entry already assessed against is retired, not deleted — a score under it must stay
   explainable.
4. An evidence specification is required and is checked before submission; five distinct anchors
   are required for a principle.
5. "Nothing adopted" is shown as a state with consequences, not as an empty list.

### E12-S07 — Setting up and entering a challenge · M · 1d
*As an organiser I want to set a challenge up in the application; as a team I want to enter my
work without an account.*

**Acceptance**
1. Create a challenge, upload a brief, extract its text and generate a rubric, in that order,
   with the order stated on the page.
2. Rubric generation is unavailable until at least one document's text has been extracted.
3. Extraction status is shown per document, not as one summary.
4. A team submits with a scoped submission token and no account (P8.2); the form states whether
   intake is open before anything is filled in.
5. The receipt names the commit that was locked, and says that later pushes will not change it.

### E12-S08 — Letting teams in · M · 0.75d
*As an organiser, I want to open intake and issue the tokens teams submit with, without
reaching for curl.*

Both of these gate every submission, and neither had a UI at all: with no window intake refuses
everyone, and with no token a team cannot authenticate. A prerequisite that can only be met from
a terminal is a prerequisite that gets forgotten on the night.

**Acceptance**
1. An organiser can set the submission window's dates and see them in their own timezone.
2. "No window" is stated as a consequence — *no team can submit* — not as an empty field.
3. Locking is separated from closing, asks for confirmation, and names what it costs: no
   correction or resubmission afterwards, including from a team whose repository turned out to
   be private. Closing by date is reversible; locking is not.
4. Tokens are issued per team, listed, and revocable with confirmation.
5. The plaintext token is shown exactly once, with a statement that it cannot be recovered —
   only its SHA-256 is stored (P8.3).
6. A token that has never been used is flagged: before a deadline that usually means it never
   reached the team, and afterwards nothing can be done about it.

### E12-S09 — A rubric is reachable, and a frozen one is not a dead end · S · 0.5d
*As an organiser, I want to find the rubric and change what it weighs, without being told to do
something the application gives me no way to do.*

**Acceptance**
1. The rubric is one click from the challenges list, labelled with its version and status.
2. The link resolves to the published version if there is one, else frozen, else newest draft —
   teams are judged by what was published, so that is what "the rubric" must mean.
3. A frozen rubric offers "create a new version from this one" rather than only refusing.
4. The new draft carries the source's criteria and dimension weights forward. Adjusting one
   weight must not require retyping the rubric — a retyped rubric is a different rubric.
5. The quality gate's `needsRewrite` verdict is **not** carried over: it judged the old wording,
   and inheriting it would either excuse a fresh problem or condemn a fixed one.
6. A version can only be copied from another version of the same challenge.

---

# Part IV — Delivery

## IV.1 Two tracks

**Track A — committee, no code.** Read both briefs against the E02-S05 quality bar; decide the
principles list (OD-2); agree the build-declaration rule for the published rules (OD-3); run
the E02-S06 review session; decide the lopsided-split policy (OD-1).

**Track B — engineering.** Everything else. **E04 and E01 start immediately** — neither depends
on the briefs.

## IV.2 Sequencing

```
Week 1   E01 foundation                    ─┐
         E02-S03 rubric schema  ← do first  ├─ unblocks everything
         E04 scanner extraction            ─┘
Week 2   E02 intake + synthesis
         E05 prober sandbox
         E03 submission intake
Week 3   E06 scoring engine
         E07 composite + ranking
Week 4   E08 review UI
         E10 batch operations
         E09 threaded throughout
Week 5   E11 calibration → GO/NO-GO
         E11-S04 full dry run
Week 6   Buffer. Real evaluation.
```

**Critical path:** E02-S03 → E06-S01 → E06-S02 → E07 → E11-S02 → gate.

**Total:** ~50–65 engineer-days. One engineer ≈ 11–13 weeks; two ≈ 6–7 weeks; three ≈ 4–5 weeks
with E04/E05/E02 parallelised.

> **If under three weeks are available:** cut E06 to engineering quality and the objective Runs
> dimension only, drop challenge-fidelity scoring, and have humans read the top 25 against the
> briefs. An uncalibrated rubric scorer is worse than no rubric scorer.

## IV.3 Risk register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | Untrusted code execution in E05 | **Critical** | E05-S01 in full, including the hostile fixture test |
| R2 | Non-deterministic scores contested by teams | **High** | E06-S06, E08-S04, E09-S02 |
| R3 | Briefs too thin to generate checkable criteria | **High** | E02-S05 gate; enrich the brief, don't tune the generator |
| R4 | Calibration fails near the event | **High** | E11 gate with a documented human fallback |
| R5 | Cost or wall-clock overruns on the night | Medium | E10-S02, E10-S03; sized by E11-S04 |
| R6 | File budget silently truncates large repos | Medium | E04-S04 surfaces it; E08-S06 labels it |
| R7 | Lopsided challenge split in the top 20 | Medium | E07-S05 reports it; OD-1 decides policy in advance |
| R8 | A repo goes private after submission | Low | E03-S02 rescan until lock |

## IV.4 Open decisions

| # | Decision | Owner | Needed by |
|---|---|---|---|
| **OD-1** | If the top 20 splits 18–2, do we accept it? | Committee | Before E07-S05 |
| **OD-2** | Adopt the nine cloud-architecture pillars, or write our own principles list? | Committee | Before E06-S03 |
| **OD-3** | Mandate a Dockerfile or documented build command in the published rules? | Committee | **Before submissions open** |
| **OD-4** | Event window definition for provenance (E04-S06) | Committee | Before E04-S06 |
| **OD-5** | Who operates the run on the night, and who is on call? | Organisers | Before E11-S04 |
| **OD-6** | Retention policy for cloned repositories and logs after the event | Organisers | Before E01-S02 |

## IV.5 Definition of done — system level

1. A frozen, published rubric exists for each challenge, hash-recorded.
2. Every submission has a validated repo URL, a recorded commit SHA and a build-probe result.
3. Every submission has two independent score runs with evidence at file-and-line granularity.
4. Ranking is global, with fidelity normalised within cohort and the challenge split reported.
5. Calibration passed its gate, or the human fallback was invoked and recorded.
6. Every flag in the cut band was reviewed by a person and the review recorded.
7. An appeal packet can be produced for any team in one action.

---

*Findings in Part I were verified against live source on 2026-09-22. Line counts and file paths
are accurate as of that read. Sizes are estimates; the E11-S04 dry run replaces the cost and
wall-clock figures with measurements.*
