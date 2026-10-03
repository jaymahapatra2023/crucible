# Crucible — Architecture Principles

**Version 2.0 | Adopted 2026-09-22**

These principles govern every engineering decision in Crucible: new features, refactors, LLM
integrations, frontend components, database design, infrastructure, and background jobs. When a
decision conflicts with a principle, **the principle wins** unless a documented exception is
approved by a senior architect and recorded in the module's `TECH_DEBT.md`.

> **Provenance.** Crucible borrows proven patterns from an upstream reference implementation
> (see `docs/adr/0001-provenance-and-naming.md`). Borrowed code is renamed to Crucible-native
> naming on the way in. No file, symbol, comment, table, or document in this repository may
> reference the upstream product by name; `pnpm guard:naming` enforces this in CI.

---

## 0. Platform Purpose & Quality Mandate

Crucible is a hackathon submission triage system. It evaluates 40–50 untrusted repository
submissions across multiple challenges and produces a ranked shortlist for human confirmation.

**The primary value driver is defensibility.** Crucible's output eliminates roughly thirty teams
from a competition. A score without traceable evidence, a rank that cannot be reproduced, or a
rubric that cannot be shown to have been published in advance causes real harm to real
participants and cannot be defended in an appeal.

> **Quality is not a feature. It is the product.**

Every engineering decision must be evaluated against: does this make the outcome more accurate,
more reproducible, and more explainable six months from now? Velocity that sacrifices
defensibility is negative progress.

**Three constraints follow from the purpose and outrank convenience everywhere:**

1. **Shortlist, don't decide.** The system ranks; humans confirm. No code path marks a team as
   finally selected or finally rejected without a recorded human decision.
2. **Every score carries evidence** at file-and-line granularity. A score without one is
   unusable in an appeal and is therefore a defect.
3. **Untrusted code is hostile code.** Every submission repository is assumed malicious until
   proven otherwise. See P8.6.

---

## Part 1 — Structural Principles

### P1. Modularity & Service Boundaries

#### P1.1 Every domain is a bounded module

The platform is organized into bounded modules, each owning its data, its LLM calls, its API
routes, and its UI. Modules share only published contracts — API interfaces, event schemas, and
shared TypeScript types in `packages/`.

**Canonical module boundaries:**
```
challenges/     — Challenges, brief artifacts, document extraction
rubrics/        — Rubric synthesis, quality gate, review, freeze, publication
submissions/    — Team submissions, repo validation, intake window
scans/          — Repository scanning, provenance analysis
probes/         — Sandboxed build-and-run probing
scoring/        — Criterion scoring, dimension aggregation, composite, ranking
review/         — Shortlist review, flags, overrides, finalisation
governance/     — Audit log, appeal packets, identity and RBAC
batch/          — Cohort orchestration, concurrency, cost budget, resume
preflight/      — Per-submission tier-2 checks, queued after intake, advisory (E46)
calibration/    — Golden set, calibration report, go/no-go gate
llm/            — Gateway, call registry, prompt templates, observability, evals
platform/       — Runtime config, feature flags, run ledger, health
```

#### P1.2 Microservice-ready from day one

The platform runs as a modular monolith today and must be decomposable into independently
deployable services as load and team size grow. Every module is structured so it can be
extracted with wiring changes only — no code rewrites.

Each module follows this internal structure:
```
/modules/{module}/
  routes/          — HTTP handlers (thin; delegate immediately to services)
  services/        — Business logic (no HTTP awareness; no direct SQL)
  db/              — Module-specific query functions (all SQL lives here)
  jobs/            — Background workers (producers and consumers)
  events/          — Domain event publishers and subscribers (none exist yet — see P12.1)
  types/           — Module-local TypeScript interfaces
  tests/           — Unit + integration tests for this module
  TECH_DEBT.md     — Known principle violations (P13.1)
```

Modules communicate only via:
1. **HTTP API calls** — when a synchronous response is required
2. **Domain events** — when fire-and-forget or fan-out
3. **Published read models** — a dedicated DB view that Module B maintains as a contract for
   Module A to read

#### P1.3 No cross-module database coupling

A module owns its tables. No other module writes to them directly. No cross-module foreign keys.
No cross-module table joins in application code.

If Module A needs data owned by Module B, it either calls Module B's API or reads from a
published view that Module B explicitly maintains as a contract. Published views are named
`v_{owning_module}_{concept}` and are the only cross-module read surface.

> **Consequence, stated explicitly so it is not rediscovered as a bug:** referential integrity
> across module boundaries is enforced in the service layer and verified by a scheduled integrity
> check (`platform.integrity`), not by a database constraint. Within a module, foreign keys are
> mandatory. See `docs/adr/0002-module-boundaries-and-referential-integrity.md`.

#### P1.4 File size limits are hard constraints

Long files are a symptom of missing decomposition. These limits are enforced in CI via ESLint
`max-lines`:

| File type | Max lines | Notes |
|---|---|---|
| Route handler file | 300 | Routes are thin wrappers; logic lives in services |
| Service file | 400 | Single responsibility; split at first violation |
| Orchestrator / coordinator | 600 | Coordinates multiple services; justify every 50 lines over 400 |
| Database query module | 300 | One `db/` file per domain entity |
| React component | 250 | One component per file; extract sub-components aggressively |
| React page | 400 | Pages compose components; no inline business logic |
| Database migration | 150 | One concern per migration; split if larger |
| Utility / helper | 200 | Pure functions only; no side effects |
| Test file | 500 | One test file per source file; split by test category if larger |
| TypeScript type file | 150 | Split by domain concept |

Files that exceed these limits are tracked in Appendix D and must be decomposed on the next
substantive touch.

#### P1.5 Variant extensibility — one strategy per variant, behind one registry

When a module must behave differently along a **variant axis** — a Dockerfile vs command build
path, a PDF vs DOCX vs Markdown extractor, one LLM provider vs another, one scoring dimension vs
another — that variation is expressed as **one contract, a base of shared defaults, one
registered strategy per variant, and composition for sub-variants**. It is *not* expressed as
scattered `switch (kind)` blocks, parallel dispatch maps, or per-concern handler tables that each
re-branch on the same axis.

This is the Strategy + Template-Method + Registry pattern, applied as the default shape for any
module with a variant axis:

1. **One contract.** A single interface declares every capability that varies. Adding a
   capability is one method on one interface — every variant is forced to consider it.
2. **A base provides shared behavior.** An abstract base implements the generic path; a variant
   overrides only what differs. The base IS the default — an unregistered variant gets correct
   generic behavior, not a crash.
3. **One registry, keyed by the variant.** A single `registryFor(variant)` lookup replaces all
   ad-hoc dispatch. **Adding a variant = one strategy file + one registry line.**
4. **Composition for sub-variants.** Patterns *within* a variant are composed objects activated
   by evidence (`appliesTo(ctx)`), not a deepening class hierarchy.
5. **Single owner per variant.** All of a variant's behavior cohabits one place. A reader
   changing "how the Dockerfile path works" has exactly one front door.
6. **No parallel dispatchers.** There is exactly **one** mechanism that branches on a given axis.
   Multiple independently-keyed dispatchers for the same axis drift and must be hand-synced.
   Derive secondary views (ordering, capability matrices) from the single declaration.
7. **One config seam per variant.** A variant's config resolves through its strategy (DB-backed
   per P3.6/P7.5), with the base's defaults as the single code-side fallback — not N duplicated
   `DEFAULT_*` constants, each its own drift surface.

**Smell test (a P1.5 violation):** adding a new variant requires editing 3+ files in different
subsystems; the same `switch`/`if (type === …)` appears in more than one module; "which behavior
for which variant" is defined in more than one place; or a variant's logic is scattered such that
some of it is unreachable without anyone noticing.

**Crucible's declared variant axes,** each of which must have exactly one registry:

| Axis | Registry | Variants |
|---|---|---|
| Brief artifact format | `challenges/services/extractorRegistry` | PDF, DOCX, Markdown, plain text |
| Build method | `prober/src/strategyRegistry` | Dockerfile, command |
| Scoring dimension | `scoring/services/dimensionRegistry` | fidelity, engineering, principles/standards, runs, originality |
| LLM provider | `llm/services/providerRegistry` | Anthropic API, CLI fallback |
| Repo host | `submissions/services/hostRegistry` | GitHub, GitLab |

**Migration of existing violations:** retrofit via strangler-fig — introduce the contract + base
+ registry, wrap existing code behind it (behavior-preserving, golden-tested), route call sites
through the registry one at a time, then delete the superseded dispatchers. Never a big-bang
rewrite.

---

### P2. File Decomposition Strategy

When a file exceeds its limit, follow this protocol:

1. **Identify responsibilities** — list every distinct thing the file does
2. **One responsibility = one file** — each responsibility becomes its own service file
3. **Orchestrator** (≤ 600 lines) coordinates the responsibility files in order
4. **Shared types** move to the module's `types/` directory
5. **Test coverage first** — write unit tests against the existing code before decomposing; tests
   verify behavior is preserved after the split

**Worked example — the ported repository scanner (E04).** The upstream implementation was a
single 2,092-line file mixing eight responsibilities. It enters Crucible decomposed, never as a
verbatim copy:

```
packages/scanner/src/
  scanRepository.ts        (≤ 400) — the public entry point and orchestration
  cloneWorkspace.ts        (≤ 200) — ephemeral clone, commit snapshot, guaranteed cleanup
  fileGathering.ts         (≤ 300) — directory walk, skip lists, budget application
  depthProfiles.ts         (≤ 150) — depth profile definitions and resolution
  chunking.ts              (≤ 200) — deterministic chunking and result merging
  repoStats.ts             (≤ 200) — language mix, size, file counts
  codeMetrics.ts           (≤ 300) — metric extraction from gathered files
  provenance.ts            (≤ 300) — git history analysis (E04-S06)
  jsonExtraction.ts        (≤ 150) — JSON-from-model-text extraction
  types.ts                 (≤ 150) — scanner result interfaces
```

---

## Part 2 — AI & LLM Quality Principles

### P3. LLM Gateway

#### P3.1 All LLM calls go through the gateway

No service calls any LLM provider directly. Every LLM call is routed through
`llmGateway.callModel()` with a registered `callKey`.

```typescript
// CORRECT
const result = await callModel({ callKey: 'scoring.criterion', variables: { ... }, schema })

// FORBIDDEN — bypasses audit, fallback, config, and observability
const response = await anthropic.messages.create({ ... })
```

**Banned patterns:** `new Anthropic()` in service files; direct provider SDK use outside
`modules/llm/providers/`; inline `fetch`/`https.request` to any LLM API. Enforced by
`pnpm guard:llm` in CI.

#### P3.2 Every call site has a stable call_key

Each distinct LLM use case has a unique, human-readable `call_key` of the form
`module.purpose` (e.g. `rubrics.criteria_generate`, `scoring.criterion`). The key is registered
in `llm_call_registry` and is immutable. It appears in logs, dashboards, alerts, and fallback
rule configuration.

Naming: `<module>.<submodule?>.<action>` — all lowercase, dot-separated.

#### P3.3 Prompts are stored in the database, not in code

Prompt templates live in `llm_prompt_template`, versioned, with `{{variable}}` placeholders.
Services pass only variables. Operators tune prompts without a redeploy.

Inline prompts are permitted only for short, stable, utility normalization calls (< 3 lines) and
must be annotated: `// NOTE: inline prompt — migrate to DB on first optimization need`.

#### P3.4 Every LLM call is audited

Every call produces a row in `llm_call_log`: `call_key`, `model_used`, `status`, `latency_ms`,
`prompt_hash`, `token_counts`, `cost_usd`, `attempt`, `fallback_triggered`, `correlation_id`.
Log writes are fire-and-forget — a DB failure must not propagate to the caller.

Content control: `log_prompts` and `log_responses` default to `FALSE` in `llm_call_config`. Full
prompt text is stored only when explicitly enabled per call_key. The default stores a SHA-256
hash only. **Submission source code is never stored in the call log** regardless of the flag.

#### P3.5 Non-LLM fallbacks for every critical call

Every call site that can tolerate degraded output must define a fallback handler and set
`has_fallback = TRUE` in `llm_call_registry`. Fallbacks are deterministic, rule-based, and fast
(< 100 ms). Types: `RULE_BASED`, `PASSTHROUGH`, `TEMPLATE_RETURN`, `SHA256_DEDUP`,
`FIELD_FORMULA`.

**Exception, load-bearing for this product:** a criterion score has **no** fallback. Where
judgement cannot be obtained, the correct output is `SCORING_FAILED` or `insufficient_evidence` —
never a synthesised number. Silence is honest; a fabricated score is not. Such call keys set
`has_fallback = FALSE` and declare `failure_is_terminal = TRUE`.

#### P3.6 Config-driven behavior — nothing hardcoded

Model IDs, timeouts, batch sizes, retry counts, temperature, concurrency limits, cost ceilings,
depth profiles and every threshold — all live in DB config tables. Services read via a
60-second in-process LRU cache. Hardcoded values are CI failures.

**Config tables that must never be substituted with hardcoded constants:**
`llm_call_config`, `llm_prompt_template`, `llm_fallback_rule`, `app_config`, `feature_flag`

---

### P4. LLM Output Quality

#### P4.1 Validate every LLM output before storage

No LLM output is written to the database without:
1. **Schema validation** — output conforms to the expected format (all required fields present)
2. **Content validation** — output is substantive (not empty, not an error message)
3. **Semantic validation** — output satisfies quality criteria for its type (e.g. a criterion
   score carries at least one evidence reference with a path and a line range; a generated
   criterion carries five materially distinct anchors)

#### P4.2 Classified retry strategy — never retry blindly

On validation failure, classify the failure before retrying:

| Failure class | Retry strategy |
|---|---|
| `TOO_SHORT` | Reduce context 50%, retry same prompt |
| `BAD_STRUCTURE` | Add explicit format instruction + example |
| `JSON_PARSE_ERROR` | Add JSON-only constraint + schema example |
| `TIMEOUT` | Increase timeout, try smaller/faster model |
| `CONTENT_EMPTY` | Try a different model; flag as HIGH_RISK |

Maximum 3 retries with different strategies. After 3 failures, **fail the unit of work
explicitly**. Never store a stub placeholder as if it were a real result, and never default a
failed score to zero.

#### P4.3 Worker / Reviewer / Judge for reviewed artifacts

Artifacts that carry a review requirement follow a mandatory 3-pass pattern:

1. **Worker** — generates the artifact (primary model, full context)
2. **Reviewer** — independently reviews completeness and accuracy (separate call)
3. **Judge** — compares outputs, makes a pass/fail decision, applies a consensus threshold

Where it applies, reviewer is **mandatory**, not optional. If the reviewer is unavailable, the
step fails — it does not silently degrade. Store all three outputs separately. Mark reviewer
additions as `REVIEWER_INFERRED` — never merge inline without tracking.

**Where it applies is declared in one place**, and it is not the criticality column:
`llm_call_registry.requires_review`. A test pins the exact set, so a CRITICAL call key added
without a review pass fails by name rather than passing unnoticed.

| Call key | Criticality | `requires_review` |
|---|---|---|
| `rubrics.criteria_generate` | CRITICAL | **yes** — `rubrics.criteria_review` + `rubrics.criteria_judge` |
| `rubrics.quality_gate` | CRITICAL | no |
| `scoring.criterion` | CRITICAL | no — see below |
| `scoring.engineering` | CRITICAL | no — see below |
| `scoring.principles` | CRITICAL | no — see below |
| `scoring.standards` | CRITICAL | no — see below |

**Criticality is not a synonym for reviewed.** It governs retry policy, terminality and logging.
The four scoring keys are CRITICAL and are deliberately **not** reviewed: adding the pattern to
them roughly triples the dominant spend of an evaluation, and whether it is needed is precisely
what the calibration gate exists to establish. The reasoning, the controls that stand in its
place — citation verification against the scan, three validations, deterministic evidence
selection, the double run, the calibration gate, human review of the cut band — and the evidence
that would reverse the decision are recorded in
[ADR 0004](adr/0004-no-reviewer-judge-for-scoring.md).

> The double score run (E06-S06) is a *separate and additional* control from worker/reviewer/
> judge. W/R/J improves a single answer; the double run measures reproducibility across runs.
> Neither substitutes for the other.

#### P4.4 Determinism by design

Repeated runs on the same input must produce semantically consistent outputs:
- Sort all file lists before processing — filesystem and API ordering are undefined
- Pin the model version per run; config changes do not affect an in-flight run
- Store a SHA-256 content hash of every artifact; skip regeneration if the hash matches
- Use explicit chunk-and-merge (chunk → analyze each → union results), never a random drop on
  budget overflow
- Temperature defaults to 0 for every scoring call key

#### P4.5 Confidence metadata on every extracted fact

Every fact extracted from a codebase or document carries an explicit confidence level:

| Level | Meaning | Downstream treatment |
|---|---|---|
| HIGH | From an explicit declaration or annotation | Used in automated aggregation |
| MEDIUM | Inferred from naming or structure | Surfaced as "inferred"; used with caution |
| LOW | Guessed from context | Shown as "unverified"; requires human confirmation |

Low-confidence facts are stored, surfaced visually as uncertain, and excluded from automated
ranking decisions at the cut line.

#### P4.6 Evidence, not summaries

Every model-scored judgement is accompanied by the **source excerpt it rests on** —
`{ path, line_start, line_end, excerpt }` — not a prose summary of the repository. A pipeline
stage that passes a derived summary where source was available is a P4.6 violation. This is the
principle that makes an appeal answerable, and it is the reason the scoring context builder
(E06-S01) passes real code rather than a tech-stack list.

---

## Part 3 — User Experience Principles

### P5. Seamless & User-Friendly Interface

#### P5.1 Real-time progress, never polling

Long-running operations (> 3 seconds) communicate progress via WebSocket. The frontend shows the
current stage name, elapsed time, estimated remaining, streaming log lines for technical users,
and a plain-language summary for organisers.

HTTP polling for progress is not permitted.

#### P5.2 Progressive disclosure

Default views show summary-level information. Drill-down reveals per-dimension detail. Further
drill-down shows criterion-level evidence with source excerpts. No page shows more information
than the role needs at first load.

Role-appropriate defaults:
- **Organiser** — cohort status, cut-line band, flags requiring decision
- **Reviewer** — ranked table, team detail, evidence
- **Admin** — runs, cost, config, audit
- **Viewer** — published rubric and final shortlist only

#### P5.3 Optimistic UI with graceful reconciliation

Mutations update the UI immediately, then reconcile with the server response. If the server
rejects, the UI rolls back with a clear plain-language explanation — not a raw HTTP status code
or a stack trace. Technical detail is available via "View details" for admin users.

#### P5.4 Zero dead ends

Every empty state tells the user what to do next:
- No data → explain what needs to happen and provide a direct CTA
- Work pending → show progress and estimated completion
- Error → explain what failed in plain language and offer Retry / Contact Support

Error messages answer: "What happened? Who is affected? What do I do now?"

#### P5.5 Accessibility and responsive layout

All pages meet WCAG 2.1 AA. Contrast ratios, focus management, ARIA labels and keyboard
navigation are tested in CI. Layout is responsive from 1280 px to 2560 px. Keyboard shortcuts are
documented and consistent.

#### P5.6 Page load performance

- First Contentful Paint < 1.5 s at 10 Mbps
- All pages lazy-loaded (`React.lazy` + `Suspense`)
- Data-heavy pages use pagination or virtual scrolling — no full-table renders in the DOM
- Model-generated content streams to the UI as it arrives; never buffer and display all at once

#### P5.7 Data honesty at the point of display

A number on screen is either a real backend count or is labelled as partial. Specifically:
- Totals come from a backend `COUNT`, never from `array.length` of a bounded fetch
- A bounded fetch states "showing X of Y"
- A failed fetch is visually distinct from an empty result — never rendered as "0"
- A truncated scan, a partial dimension, a cohort fallback, or an advisory-only score is labelled
  **where it is displayed**, not only in a detail panel

> This principle exists because the product's output eliminates people. A reviewer who
> misreads a partial fetch as a complete one makes an unsound decision and cannot know it.

---

## Part 4 — API Design Principles

### P6. API Contracts

#### P6.1 RESTful resources, versioned from creation

```
GET    /api/v1/{module}/{resource}               list
POST   /api/v1/{module}/{resource}               create
GET    /api/v1/{module}/{resource}/{id}          get one
PUT    /api/v1/{module}/{resource}/{id}          full replace
PATCH  /api/v1/{module}/{resource}/{id}          partial update
DELETE /api/v1/{module}/{resource}/{id}          delete
POST   /api/v1/{module}/{resource}/{id}/{verb}   actions (approve, freeze, finalise)
```

Breaking changes require a new version prefix (`/v2/`), not modification of existing endpoints.
Existing versions are deprecated with a sunset header before removal.

#### P6.2 Consistent response envelope

```typescript
// Success
{ data: T, meta?: { total?: number, page?: number, pageSize?: number } }

// Error
{ error: { code: string, message: string, details?: unknown } }
```

HTTP status codes are semantically correct. Never return 200 with `{ success: false }`.

#### P6.3 Pagination on all list endpoints

No list endpoint returns an unbounded result set. Default page size 20, maximum 100. Pagination
metadata always in `meta`, and `meta.total` is always a real backend count (P5.7).

#### P6.4 Idempotency for mutations

POST endpoints that create resources or trigger operations accept an `Idempotency-Key` header.
Repeated calls with the same key return the original result without additional side effects.

#### P6.5 Input validation at every boundary

All API inputs (request body, query params, file uploads) are validated against explicit `zod`
schemas at the route layer before reaching services. Services trust data passed from within the
process. They validate data arriving from HTTP, jobs, events, model output, and uploaded files.

---

## Part 5 — Data, State & Traceability Principles

### P7. Data Integrity

#### P7.1 Immutable audit trails for governance-critical state

For entities where state changes have governance implications, history is append-only. Write a
new version row; point `current_version_id` at the latest. Never update in place.

Entities requiring immutable history: `rubric`, `rubric_criterion`, `criterion_score`,
`composite_score`, `review_decision`, `audit_event`, `llm_call_log`, `shortlist`.

A `FROZEN` rubric is immutable **at the database level** — enforced by a trigger, not only by
application code (E02-S07).

#### P7.2 Content hashing for all generated artifacts

Every generated artifact carries:
- `content_hash CHAR(64)` — SHA-256 of the normalised content
- `generation_attempt INT` — which attempt produced it
- `model_used VARCHAR(100)` — the model that produced it
- `previous_id` — version chain link

Only write a new row if the hash differs from the current version. This enables idempotent
re-runs and root-cause analysis of output changes.

#### P7.3 End-to-end traceability is mandatory

Every number in the final ranking must be queryable through the full chain:

```
Brief passage → Criterion (source_ref) → Rubric version + hash → Criterion score
  → Evidence (path, lines, excerpt) → Dimension score → Composite → Rank → Decision
```

Any break in the chain is a gap logged to `traceability_gap`. The appeal packet (E09-S02) is
precisely a rendering of this chain for one team, and its generation must not require a single
hand-written query.

#### P7.4 Soft deletes with reason codes

No row is hard-deleted unless it contains personal data scheduled for erasure. All soft deletes
record `deleted_at`, `deleted_by` and `delete_reason` (enum: `USER_REQUEST`, `ADMIN_ACTION`,
`GDPR_ERASURE`, `CASCADE`, `DEDUP`, `SUPERSEDED`).

#### P7.5 Database is the single source of truth for configuration

No configuration lives only in environment variables or in-memory state without a DB reflection.
Env vars are bootstrap-only (DB connection string, JWT secret, provider API key). All runtime
behavior lives in the DB and survives a restart.

---

## Part 6 — Security Principles

### P8. Security by Default

#### P8.1 Authenticate every request, authorize every action

Every route requires either session/JWT auth (via `requireAuth`), or an explicitly named
alternate authentication factor documented at its mount point — never the silent absence of auth.
Every mutation is additionally authorized against RBAC permissions (`resource:action`) checked
server-side. Never rely on UI hiding a button as authorization.

**The complete set of unauthenticated routes.** Entries are `METHOD /path` and the match is
**method-specific**: `POST /api/v1/submissions` is a team submitting with a token, while `GET` on
the same path lists every team's name, contact and repository and is not public. A route not on
this list and not added here with the same rigor is a defect, not a decision:

- `GET /health`, `GET /ready` — liveness and readiness probes, no data.
- `POST /api/v1/auth/login` — authentication bootstrapping itself.
- `GET /metrics` — Prometheus scrape convention; scrapers carry no JWT. Exposes counts and
  latencies only — never submission, team or score data.
- `GET /ws/progress` — WebSocket handshake. Browsers cannot set an `Authorization` header on a handshake, so
  the token travels as a query parameter and is verified at the mount point. This is a named
  alternate authentication factor, not an absence of authentication.
- `GET /api/v1/rubrics/published/:slug` — the published rubric, by design: teams must be able to read
  the standard they are judged by **before** submissions open, without an account (E02-S08).
- `POST /api/v1/submissions` — team self-submission, authenticated by a scoped, revocable
  submission token (P8.2) verified at the mount point. Teams are not Crucible users by design:
  issuing fifty accounts for one evening is all risk and no benefit.
- `GET /api/v1/submissions/status` — whether intake is open. A team needs this before it has a
  token in hand, and it carries no team or submission data.
- `GET /api/v1/submissions/mine` — a team's OWN entry and its validation state, authenticated by
  the same submission token at the same mount point (E17-S03). The team id is taken from the
  verified token and the endpoint accepts no team parameter at all, so there is nothing to tamper
  with: one team's token cannot address another team's entry.
- `GET /api/v1/challenges/open` — the id and name of OPEN challenges, plus the slug of each
  one's published rubric where there is one. A team filling in the submission form has to say
  which challenge they are entering, and must be able to read the standard they will be judged
  by (E17-S04), with no account to do either with. Scoped deliberately: OPEN only, and no brief,
  artefact or draft rubric is reachable — that slug addresses the already-public published
  rubric and nothing else.

#### P8.2 Tokens are scoped and revocable in real time

Submission tokens and API keys carry explicit scopes. Revocation takes effect immediately — no
cache window on a revoked credential.

#### P8.3 Secrets are never in code

Provider API keys, JWT secrets and DB passwords are environment variables or a secret manager.
Secret scanning runs in CI. Any commit matching a secret pattern is rejected. No secret is ever
written to a log, including inside an error payload or a captured stack trace — the logger
redacts by key name and by value match against the loaded secret set.

#### P8.4 LLM prompt injection defense

Crucible feeds **untrusted, adversarially-motivated content** — submission source code and team
READMEs — directly into scoring prompts. A team that can influence its own score by writing
instructions in a comment has broken the competition.

User- and submission-supplied content embedded in any prompt is:
1. Sanitized to remove structure that could override prompt framing
2. Bounded by explicit delimiters with instructions to treat the span as data only
3. Never placed in the system prompt — only in the user turn, clearly labeled
4. Scanned for injection patterns; a detection raises a `PROMPT_INJECTION_SUSPECTED` flag on the
   submission for human review and **is never silently stripped and scored anyway**

#### P8.5 Defense in depth — no single point of trust

Auth middleware validates the token. Permission middleware validates the action. The service
layer validates business rules. The DB has row-level constraints and triggers. No layer trusts
the layer above it for a security-critical decision.

#### P8.6 Untrusted code executes only in a disposable sandbox

Every execution of submission code runs in an ephemeral container with: no host filesystem mount,
network egress denied by default, CPU/memory/PID caps, a hard wall-clock timeout, no host
environment or credentials reachable inside, and logs captured to a size cap. The container is
destroyed regardless of outcome.

This control is verified by an adversarial fixture in CI — a submission that attempts a network
callout, a fork bomb, and a host path write — and the test asserts containment of all three. The
fixture is **not** optional and a green suite without it is not evidence of anything.

---

## Part 7 — Observability Principles

### P9. Observability as a First-Class Citizen

#### P9.1 Structured logs everywhere

All log output is structured JSON. No `console.log` with string interpolation. Every log line
includes `timestamp`, `level`, `module`, `service`, `correlationId`, and domain context
(`runId`, `submissionId`, `callKey` when relevant).

#### P9.2 Correlation IDs end-to-end

HTTP requests generate or propagate `X-Request-ID`. Background jobs carry the run ID. All
downstream calls (DB, LLM, container probes) carry the same ID, so one cohort evaluation is
traceable across every stage and every model call.

#### P9.3 LLM calls have dedicated metrics per call_key

Track per `call_key`: P50/P90/P99 latency, success rate, fallback rate, error rate, token
consumption for cost attribution, and quality-score trend. Alert when the error rate exceeds 5%
over 15 minutes, P99 latency exceeds 2× baseline, or the fallback rate exceeds 20%.

#### P9.4 Pipeline stages publish health indicators

Each pipeline stage (scan, probe, score, aggregate, rank) reports status — `PENDING`,
`IN_PROGRESS`, `HEALTHY`, `DEGRADED`, `FAILED` — plus completion rates, flag counts by severity,
and cost consumed. An operator sees at a glance which submission's which stage is failing and
why, without reading logs.

#### P9.5 Error budgets per module

Each module has an error budget (99.5% for synchronous API calls, 99.0% for background jobs),
tracked in `module_health_daily`. At 50% consumed → alert; at 100% consumed → the module enters
safe mode (disable non-critical features, force conservative fallbacks).

---

## Part 8 — Testing & Quality Gates

### P10. Quality is Enforced by CI

#### P10.1 Test pyramid

| Layer | Coverage target | Scope |
|---|---|---|
| Unit | ≥ 80% line coverage on changed files | Pure logic; mock all I/O |
| Integration | All critical paths per module | Real DB (test instance); mock external APIs |
| API contract | Every endpoint | Envelope, status codes, validation, authz |
| E2E (Playwright) | All user-facing workflows | Full stack — UI, API, DB state |
| LLM eval | All registered `call_key`s | Golden datasets; quality-score regression |
| Security | The sandbox containment fixture (P8.6) | Adversarial, runs on every PR |

#### P10.2 No merge without passing quality gates

CI gates for every PR:
1. TypeScript `strict: true` — zero untyped `any`
2. Unit tests ≥ 80% coverage on changed files
3. Integration tests pass
4. ESLint clean (including the `max-lines` rule)
5. Secret scanning clean
6. API contract tests pass (no breaking changes to existing endpoints)
7. LLM quality regression: if any LLM call site changed, the quality score must not drop > 5% on
   the golden dataset
8. `guard:naming` clean — no upstream-platform reference anywhere in the tree
9. `guard:llm` clean — no direct provider SDK call outside the gateway

#### P10.3 TypeScript interfaces as contracts

Shared interfaces in `packages/` are contracts between modules. Changing a shared interface
requires updating all consumers in the same PR. Types used in published API routes or events are
versioned with the route.

---

## Part 9 — Performance & Scalability

### P11. Performance by Design

#### P11.1 Async jobs for all operations > 3 seconds

HTTP handlers return immediately with a run or job ID. The client subscribes via WebSocket for
progress and completion. No synchronous HTTP endpoint blocks for more than 3 seconds. Scanning,
probing, scoring and batch evaluation are always asynchronous.

#### P11.2 Cache aggressively, invalidate precisely

| Data | TTL | Invalidation trigger |
|---|---|---|
| LLM call config | 60 s in-process LRU | Config admin API call |
| Prompt templates | 5 m in-process LRU | Template update API call |
| App config | 60 s in-process LRU | Config write event |
| User permissions | 30 s in-process LRU | Role change event |
| Frozen rubric | Immutable — cache indefinitely by `content_hash` | Never (a change is a new version) |

Never rely on TTL expiry alone for critical config updates — publish an invalidation event.

#### P11.3 Database queries are bounded and indexed

- Every query on a table expected to exceed 10 K rows has a `LIMIT`
- New queries on large tables require a corresponding index in the same migration
- N+1 queries are forbidden — batch or join
- Any query joining more than 3 tables requires an explain-plan review

#### P11.4 Stateless services for horizontal scalability

Services hold no in-process state that is not in the DB or cache. Any instance handles any
request. Session state lives in the JWT. Run state lives in the run ledger. Scale any module by
adding instances.

---

## Part 10 — Integration & Event Principles

### P12. Integration Contracts

#### P12.1 Domain events as the integration backbone

Modules publish domain events on significant state changes. Other modules subscribe. Event
schemas are versioned TypeScript interfaces, to live in `packages/events/` **when the first
publisher exists**.

*Status (E48-S02): no module publishes an event today, and the package that held fourteen event
names with no publisher was deleted rather than kept as a contract nothing honoured. Every
cross-module need so far has been met by a published view or a port (ADR 0002). The package is
reintroduced with its first real event, its first subscriber and a test of the delivery — not
before.*

Event naming: `{module}.{entity}.{past-tense-verb}` (e.g. `rubrics.rubric.frozen`,
`scoring.run.completed`, `submissions.submission.validated`).

Events are durable — stored before delivery. Failed delivery retries with exponential backoff.
A dead-letter queue holds permanently failed events.

#### P12.2 External integrations are isolated in adapters

Git hosts, LLM providers and the container runtime are wrapped in dedicated adapter services
with:
- A defined interface that the rest of the platform calls
- All credentials from config, never hardcoded
- Circuit breaker: 3 consecutive failures → open for 60 s
- Retry: 3 attempts with 1 s / 2 s / 4 s backoff
- Timeout: an explicit maximum for every external call

#### P12.3 Feature flags gate every major capability

New capabilities deploy behind feature flags in `feature_flag`. Flag naming:
`feature.<module>.<capability>`.

---

## Part 11 — Debt Management

### P13. Technical Debt is Explicit and Tracked

#### P13.1 Every module has a TECH_DEBT.md

`/apps/api/src/modules/{module}/TECH_DEBT.md` lists known principle violations with: which
principle is violated, why it exists, who owns remediation, and the target date.

#### P13.2 The boy scout rule

Every PR leaves the code cleaner than it found it. If a PR touches a file that violates a
principle, it either adds a TECH_DEBT entry or remediates the violation within its scope.

#### P13.3 Exceptions require documentation

When a principle cannot be followed, a documented exception is required: which principle, why it
cannot be followed, who approved it, and the remediation target date. Undocumented violations are
bugs, not exceptions.

---

## Appendix A: Principles Summary

| # | Principle | Key constraint |
|---|---|---|
| P0 | Purpose | Defensibility is the product; shortlist don't decide; every score carries evidence |
| P1 | Modularity | Bounded modules; microservice-ready; hard file size limits; one registry per variant axis |
| P2 | File decomposition | Identify responsibilities, one per file, orchestrator coordinates, tests first |
| P3 | LLM Gateway | All calls through the gateway; DB-backed prompts; stable call_keys; audit every call |
| P4 | LLM Quality | Validate outputs; classified retry; worker/reviewer/judge; determinism; confidence; evidence not summaries |
| P5 | User Experience | Real-time progress; progressive disclosure; zero dead ends; WCAG 2.1 AA; data honesty |
| P6 | API Design | Versioned REST; consistent envelope; paginated; idempotent; validated at the boundary |
| P7 | Data | Immutable audit trail; content hashing; end-to-end traceability; soft deletes; DB as truth |
| P8 | Security | Authenticate + authorize; secrets never in code; injection defense; untrusted code sandboxed |
| P9 | Observability | Structured logs; correlation IDs; per-call_key metrics; stage health; error budgets |
| P10 | Testing | 80% unit coverage; contract + E2E + eval + security gates; types as contracts |
| P11 | Performance | Async for > 3 s; precise cache invalidation; bounded queries; stateless services |
| P12 | Integration | Domain events as backbone; isolated adapters; feature-flagged capabilities |
| P13 | Debt | Tracked in TECH_DEBT.md; boy scout rule; documented exceptions |

---

## Appendix B: Checklist for Adding a New LLM Call Site

1. [ ] Register `call_key` in the `llm_call_registry` seed (module, purpose, criticality, input variables)
2. [ ] Create an `llm_call_config` row (model, timeout, temperature, retry count, `log_prompts=false`)
3. [ ] Create an `llm_prompt_template` row with `{{variable}}` placeholders
4. [ ] Implement schema validation for the expected output format
5. [ ] Implement semantic validation — what makes a "good" output?
6. [ ] Define a fallback handler and set `has_fallback=true`; or justify `failure_is_terminal=true` per P3.5
7. [ ] Add ≥ 5 golden examples to `llm_eval_case`
8. [ ] If criticality is CRITICAL, implement the worker/reviewer/judge pattern
9. [ ] Confirm submission-supplied content is delimited and labeled per P8.4
10. [ ] Add an alert rule if the error rate exceeds 5%

---

## Appendix C: Module Communication Decision Tree

```
Module A needs something from Module B — choose the pattern:

Does Module A need data NOW (synchronous response to a user request)?
  YES → Does Module B expose an API endpoint for this?
    YES → Call Module B's API (/api/v1/{module}/{resource})
    NO  → Module B MUST publish a read model (v_{module}_{concept})
           Module A reads ONLY that view — never Module B's internal tables
  NO  → Is the trigger a state change in Module A?
    YES → Module A publishes a domain event
           Module B subscribes and reacts asynchronously
    NO  → Is it a scheduled batch task?
           YES → The background job reads only published read models
```

**Never** import a service file from another module's `services/` directory.
**Never** write to a table owned by another module.
**Never** join across module-owned tables in a single query from application code.

---

## Appendix D: Current Priority Violations (Technical Debt Registry)

*No registered violations. This registry is empty by construction: Crucible is a new codebase and
every file is within its P1.4 limit as of the current build. Entries are added here — never
silently tolerated — the moment a limit is exceeded or a principle is consciously deferred under
P13.3.*

Per-module debt is recorded in each module's `TECH_DEBT.md`; this appendix rolls up only
violations that are cross-cutting or exceed a P1.4 limit.

---

## Appendix E: Decomposition Playbook

When a file crosses its P1.4 limit, decompose in dependency order, leaf-first:

1. Add unit tests against the current code to lock in behavior — **do not change behavior in this
   step**
2. Extract pure helpers first (no dependencies on the rest of the file)
3. Extract pure validation and transformation functions
4. Extract I/O adapters (clone, filesystem, container, provider)
5. Extract the units that depend on the above, in dependency order
6. What remains becomes a thin orchestrator that calls the extracted modules in order
7. Re-run the locked-in tests; they must pass unchanged

A decomposition PR changes structure only. A decomposition PR that also changes behavior is two
PRs wearing one hat, and is rejected at review.
