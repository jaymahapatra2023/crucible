# Crucible — public registration, submission readiness, and the security to carry them

Everything between "the roster and challenges are loaded" and "every team has a submission the
evaluator can actually judge" — plus the protection a second public endpoint requires before it
can exist at all.

Written against the implementation verified at **2,403 tests across 140 files**, plus 201 E2E
journeys, with 74 migrations applied.

---

# Part I — What already exists, so that none of it is rebuilt

Five things are further along than the request assumes, and two things in the request would undo
work already done. Reading this part first saves a week.

## I.1 The four modules are real, and their seams are ports

Roster, challenge setup, submission and evaluation are already separate modules with published
`v_*` views and five ports between them (`teamPort`, `logisticsPort`, `auditPort`, `mailPort`,
`extractionPort`). ADR 0002 forbids importing another module's services, and the boundary has
held — E32 found and closed the one violation.

**Nothing in this plan changes the module structure.** Every epic below adds to one module and
reaches the others through an existing port or view.

## I.2 A submission token already is a team's identity

192 bits of entropy, SHA-256 at rest, revocable in real time, bound to exactly one team, refused
at submission if the binding is missing. E17 made this the *only* identity path on purpose,
because typed team names produced three defects (G4, G13, G14): near-duplicate names nobody could
see, a corrected spelling starting a second lineage, and an audit trail that could not answer
whether a team submitted with its own credential.

**Consequence for the request:** "the participant selects a team from a dropdown on the submission
page" is the defect E17 removed, wearing a friendlier hat. The token already names the team. The
correct interface is to **resolve and display** the team once the token is entered — which is
better UX (one fewer field), leaks nothing, and cannot be got wrong.

## I.3 Team size is configured but not enforced

`roster.min_team_size` is 2 and `roster.max_team_size` is 6. The request says **3–8**. More
importantly, the numbers are read in exactly one place — `rosterReadiness` — where they produce an
**advisory warning**. Nothing refuses a team of one, and nothing will refuse a team of twelve.

For an organiser assembling teams by hand that is the right call: a half-formed team at 9am is
normal. For **public self-registration it is not**: the rule is the contract with entrants, and a
public endpoint that accepts a two-person team creates a dispute nobody can settle later.

## I.4 There is no mailer and no rate limiting

The mail **port** exists with one adapter that composes real messages and transmits nothing
(E34) — deliberately, because shipping an adapter nobody had sent a message through was worse
than shipping an honest placeholder. Every email in this plan is blocked on one provider decision.

There is **no HTTP rate limiting anywhere**: not on `/auth/login`, not on `POST /submissions`.
The LLM gateway has provider back-off; the HTTP layer has nothing.

## I.5 Submission validates, but does not discover

`validateRepository` clones at submit time and refuses on: a malformed URL, a non-https scheme,
credentials in the URL, a host outside the allow-list, a missing declared Dockerfile, and an
unreachable or private repository. It records the HEAD sha but does **not** lock it — locking
happens when intake closes.

What it does **not** do: scan, probe, build, run, extract discovery, or check for committed
secrets. So today a team can submit successfully and still be unevaluable, and nobody finds out
until evaluation night.

---

# Part II — Design decisions, and why

## II.1 A dropdown of participants is a roster breach

To populate a `<select>` of participants on a **public** page, an unauthenticated endpoint must
return 200 people's names and email addresses. That is a personal-data disclosure, and it is also
an authorisation hole: anyone could enrol somebody else's participants into a team they control.

The request's underlying want is *"don't make people type things they can get wrong"*. That is
achievable without a directory:

1. A participant enters **their own** email. The server emails a one-time registration link.
2. Inside that link's scope, teammates are added by **exact email**, confirmed one at a time. The
   response is *"Grace Hopper — added"* or *"no participant with that address"*. Nothing is listed.
3. Team name, challenge and each confirmed teammate render as removable chips, so the interaction
   *feels* like selection while the server never enumerates anybody.

Challenges **are** a dropdown, because open challenges are already public information
(`GET /submissions/status` and the published rubric are on the P8.1 allow-list).

## II.2 Email-link registration, not an event passcode

A shared passcode is one leak away from useless and cannot tell entrants apart. An emailed link
proves the registrant controls an address **already on the roster**, which is exactly the property
needed, and it produces the audit trail for "who registered this team" for free.

Cost: a participant whose address is wrong on the roster cannot register and must ask an
organiser. That is the correct failure — it surfaces a roster error before the event rather than
during it — and the organiser path already exists (E31's People tab).

## II.3 Enumeration is a tradeoff stated, not solved

"No participant with that address" tells an attacker that address is *not* on the roster.
Refusing to say makes the form unusable for the honest case, which is the common case.

**Decision: say it, and rate limit it.** The information disclosed is weak (membership in a
participant list), the usability gain is large, and the mitigation is the same rate limiter E41
installs for everything else. This is recorded here so it is a decision rather than an oversight.

## II.4 Admin-visible tokens require storing them recoverably

`access_token` stores SHA-256. A hash cannot be shown. Three options, and the request picks one:

| | What it costs | Meets the request |
|---|---|---|
| **(a) Reissue on demand** — revoke, issue, display once | nothing; already built | mostly: the old code stops working |
| **(b) Encrypt at rest**, audited reveal, purge at lock | a key compromise exposes every live token | yes |
| (c) Store plaintext | one database backup is every team's credential | never |

**Recommendation: (a), with (b) built only if re-display is genuinely required.** E47 specifies
both so the decision can be made without re-planning. If (b) is chosen, the reveal is admin-only,
every reveal is audited with actor and timestamp, the key comes from the environment and is
registered with the redactor, and the ciphertext is purged when the window locks.

## II.5 Readiness is two tiers, because a Docker build cannot live in an HTTP request

A build takes minutes. Holding a submission request open for it would time out at a proxy and
leave a team unsure whether they had entered.

- **Tier 1 is synchronous and blocks the submission.** Everything decidable in seconds.
- **Tier 2 is asynchronous and emails the outcome.** Everything that needs a clone, a build or a
  model call.

This is also what makes "email on success, email on problems" fall out naturally rather than
being bolted on.

## II.6 Tier 2 reuses the evaluation stages, it does not copy them

Scan, probe and discovery already exist as stages the batch orchestrator runs. Tier 2 runs the
same services for one submission. **No second implementation of scanning or probing is created**
— a readiness check that disagreed with the evaluator would be worse than no check at all.

---

# Part III — The epics

## E41 — A circuit breaker, not a policy

*Revised after review. The first draft proposed rate limits as protection. The objection was that
no participant should ever see an error, and it is the right objection — so the limits change shape
rather than disappearing.*

### E41.0 The reasoning, recorded

**What the first draft got wrong.** It set budgets low enough to be "protective", which means low
enough for a team resubmitting at a deadline to hit one. A 429 shown to an entrant three minutes
before the window closes is a worse outcome than every risk it was guarding against. The threat
model was also wrong: this is a **closed event** — 200 known people, 24 hours, most of them on one
network — not an open internet service. The realistic failure is a retry loop or an impatient
double-click, not an adversary.

**What survives, and why.** Two facts make this resolvable rather than a trade:

1. **Participants never touch `/auth/login`.** It is staff-only. Strict limits there cost entrants
   nothing at all and still stop credential stuffing, which is the one genuine attack this system
   is exposed to.
2. **`POST /submissions` clones a repository per call.** A runaway script can exhaust disk and
   workers without anyone intending harm. A ceiling no human can reach still stops that.

So the limits become a **circuit breaker**: set far above any legitimate human, present only to
stop a loop. A participant reaching one is, by construction, not submitting — they are looping.

### E41-S01 — Ceilings set where no person can reach them · M · 0.5d

*As an operator, I want a runaway client stopped without any entrant ever seeing a refusal.*

**Acceptance**

1. Limits are **per route**, declared in one place beside the P8.1 public-route allow-list, so a
   new public route cannot be added without a ceiling being chosen.
2. Ceilings are **generous by an order of magnitude** over the most demanding legitimate use, and
   each is justified in a comment stating the legitimate maximum it was derived from. A team of
   eight registering, or a team resubmitting after each fix, must be nowhere near one.
3. `GET /submissions/status` and `GET /submissions/mine` are **not limited at all**. They are cheap
   reads that teams poll, and polling is the behaviour the system wants.
4. Budgets live in `app_config` (P7.5) with `affects_outcome = FALSE`, so an organiser can raise or
   **disable** any ceiling mid-event without a redeploy.
5. A single flag, `feature.http.rate_limit`, turns the whole thing off. If it misbehaves during the
   event, the fix is one switch and not a deploy.
6. A refusal returns **429 with `Retry-After`** and a message that tells a human what to do, and
   says explicitly that this is a safety limit rather than a rejection of their entry.
7. A refusal is logged with the route and identifier, **never** with the token (P8.3), and is
   surfaced on the operator health screen — a triggered breaker is something an organiser must
   see, because it means something is wrong somewhere.

### E41-S02 — Where the ceilings actually sit · S · 0.25d

**Acceptance**

1. `POST /auth/login` — **strict**, per IP and per email. Staff-only, so no entrant is affected.
   This is the one limit set for security rather than as a breaker.
2. `POST /submissions` — a ceiling per token high enough for many resubmissions in an hour, chosen
   from "a team fixing a build error repeatedly", then multiplied.
3. Registration (E44) — high enough for a team of eight plus mistakes and retries, then multiplied.
4. Reads teams poll — unlimited (S01 acceptance 3).
5. Every ceiling records the legitimate maximum it was derived from, so a later reader can tell a
   breaker from a policy.
6. A test proves each public route either has a ceiling or is deliberately unlimited; adding a
   public route without a decision **fails the test**, in the same shape as the existing
   `authCoverage` allow-list pin.

## E42 — The team size rule is a rule

*3–8, refused rather than warned, wherever a team is formed.*

### E42-S01 — The bounds move and become enforceable · S · 0.25d

**Acceptance**

1. `roster.min_team_size` becomes 3 and `roster.max_team_size` becomes 8, by migration.
2. Both are read through `configService`; no literal appears anywhere.
3. `rosterReadiness` continues to **warn** for organiser-assembled teams — a half-formed team
   during setup is not an error.
4. A single declared helper answers "is this size permitted", used by every caller, so the rule
   cannot be enforced two ways (P1.5 clause 6).

### E42-S02 — Public registration refuses a team outside the bounds · S · 0.25d

**Acceptance**

1. Registration refuses fewer than 3 or more than 8 members, naming the bound and the current
   count: *"A team needs between 3 and 8 members; this one has 2."*
2. The refusal happens **before** the team is created, so a rejected attempt leaves nothing behind.
3. Removing a member from a registered team of 3 is refused with the same message, rather than
   leaving a team below the rule.
4. An **organiser** may still create and hold an out-of-bounds team through the app, and the
   readiness checklist names it. The rule binds entrants; it does not bind the people fixing
   problems on the day.

---

## E43 — Mail that actually sends

*Every email in this plan is blocked on this, and this is blocked on one decision.*

### E43-S01 — One real adapter behind the existing port · M · 1d

*As an organiser, I want a team to receive their code without me mail-merging a file.*

**Acceptance**

1. One new `MailProvider` registered in `PROVIDERS` beside the recording adapter. Nothing above
   `mailPort` changes.
2. Credentials come from the environment, are validated at boot, and are registered with the
   redactor **before** any adapter can use them (the `MAIL_API_KEY` wiring already does this).
3. A send failure is recorded against the team as `FAILED` with the provider's reason **redacted**,
   and never retried silently in a way that could double-send a credential.
4. `token_delivery` records `SENT` with a time only when the provider confirms transmission.
   `PREPARED` keeps its existing meaning and is not reused.
5. The recording adapter **stays**, is still selectable by `MAIL_PROVIDER`, and remains the
   default — so a misconfigured deployment composes and records rather than failing to boot.
6. No address and no token appears in any log line, asserted by test.

### E43-S02 — A message a team can act on · S · 0.25d

**Acceptance**

1. Templates are plain text and live in the database beside the LLM prompts, versioned the same
   way, so wording changes are auditable and do not need a deploy.
2. Every template states what happened, what the team must do, and who to contact — in that order.
3. A token appears in exactly one template (registration success) and nowhere else, ever.

---

## E44 — Participants register their own teams

*The new public endpoint, and the largest piece of work here.*

### E44-S01 — Prove the address before anything else · M · 1d

*As a participant, I want to start registering a team using only my own email.*

**Acceptance**

1. `POST /api/v1/register/start` is public, takes one email, and is rate limited by E41.
2. If the address matches a **living, unassigned** participant, the server emails a one-time link
   carrying an opaque, single-use, time-limited token — hashed at rest exactly as submission
   tokens are (P8.3). Nothing about the roster is returned in the response body.
3. If the address is not on the roster, the response says so plainly (II.3) and no email is sent.
4. If the address belongs to a participant **already on a team**, the response says which team by
   name and does not start a registration.
5. The link expires (`registration.link_ttl_minutes`, config) and is single-use; a second use is
   refused with a message that says to start again.
6. Starting twice invalidates the first link rather than leaving two live.
7. No participant data appears in any log line.

### E44-S02 — Build the team inside the link's scope · L · 1.5d

*As a participant, I want to name my team and add my teammates without typing anything twice.*

**Acceptance**

1. `GET /api/v1/register/:token` returns **only** the registering participant's own name, the open
   challenges, and the size bounds. It never returns another participant.
2. Teammates are added by **exact email**, one at a time, each confirmed with the matched
   participant's name. No endpoint lists or searches participants.
3. A teammate already on another team is refused, naming that team.
4. The same address cannot be added twice; the registrant is always a member and cannot remove
   themselves.
5. The team name is checked live against `team_normalise`, so a name that collides with an
   existing team is refused **before** submission, naming the collision.
6. A challenge is chosen from a dropdown of open challenges.
7. Nothing is written until the registrant confirms: the plan-then-confirm pattern every import in
   this system already uses.

### E44-S03 — Confirmation creates everything, or nothing · M · 1d

*As a participant, I want one button that finishes registration.*

**Acceptance**

1. `POST /api/v1/register/:token/confirm` creates the team, its memberships, and its submission
   token **in one transaction** (P7.1). A failure anywhere leaves no team, no half-roster, and no
   orphan token.
2. Size is enforced here as well as in the UI (E42-S02), because the UI is not a security boundary.
3. The registrant becomes the team's point of contact, and their address becomes the team's
   contact — reusing E28's `setContact` rather than a second path.
4. The submission token is emailed immediately (E43), and the response confirms **that it was
   sent**, never the token itself: a token in an HTTP response body outlives the response in
   proxies, logs and browser history.
5. The registration link is consumed and cannot be replayed.
6. The whole act is one audit event naming the actor as the registering participant **by id**,
   the team, and the member count — never an address (personal data, per the roster's own
   audit rule) and never the token.
7. Re-confirming is refused, naming the team that already exists.

### E44-S04 — The registration screen · M · 1d

**Acceptance**

1. A public route, in the same shape as `/submit`: no account, no navigation chrome that implies
   one.
2. Every choice that can be a dropdown is one: challenge, and nothing else (II.1).
3. Teammates show as removable chips with the matched name, so the roster is never rendered as a
   list.
4. The member count is the primary signal, against the bound: **"4 of 3–8"**.
5. Errors are inline and specific, and the confirm button is disabled with the reason stated —
   never enabled into a refusal.
6. After confirmation the screen says the code has been emailed, to which address, and what to do
   if it does not arrive. It **does not** display the token.

---

## E45 — Submission readiness, tier 1

*What can be decided in seconds, and therefore blocks.*

### E45-S01 — The team is resolved, not selected · S · 0.5d

*As a participant, I want to see which team I am submitting for, without choosing it.*

**Acceptance**

1. Entering a valid token **displays** the resolved team name and its challenge history. The team
   name field is removed from the form entirely.
2. A token bound to no team is refused at the form with the reason, not at submission.
3. Nothing on this page lists teams (I.2, II.1).
4. The typed-name rename path is **removed**: a team's name is corrected by an organiser, not as a
   side effect of submitting. *(This closes the surprise found in this session, where submitting
   silently renamed a team.)*

### E45-S02 — Checks that can refuse in seconds · M · 1d

**Acceptance**

1. In addition to today's checks, tier 1 refuses: a repository with **no substantive code** (the
   scanner already measures scaffold versus written lines), and a missing README.
2. Each refusal names the specific problem and what to change — never "validation failed".
3. Tier 1 runs inside the existing `validateRepository` call path so there is one place a
   submission is judged, not two.
4. Every tier 1 outcome is recorded on the submission with its reason, as today.
5. Tier 1 has a hard time budget (`submissions.tier1_budget_ms`, config); exceeding it records
   `PENDING` with a reason rather than refusing a team for being slow to clone.

---

## E46 — Submission readiness, tier 2

*Everything that needs minutes, and the emails that carry the answer.*

> **Built as the `preflight` module.** Three "readiness" endpoints already existed (platform,
> roster, rubrics), each meaning something else, so the code, tables, config keys and mail keys
> say *pre-flight*. The stories below keep their original wording.

### E46-S01 — A readiness run per submission · L · 1.5d

*As an organiser, I want to know a submission is evaluable before evaluation night.*

**Acceptance**

1. A readiness run executes, for one submission: **scan**, **provenance flags**, **build probe**,
   **run probe**, **discovery extraction**, and a **committed-secret check**.
2. It calls the same services the batch orchestrator calls (II.6). No stage is reimplemented.
3. Each check records `PASS`, `FAIL` or `UNKNOWN` with a reason. **`UNKNOWN` is never rendered as
   `FAIL`** — a probe the harness could not start is not a team's failure (P5.1).
4. The run is idempotent per `(submission, commit)`: re-running an unchanged submission reuses the
   existing scan rather than re-cloning.
5. It never runs inside the submission request, and never inside an evaluation run.
6. A readiness verdict is advisory to the evaluator and **blocks nothing** — it tells a team what
   to fix while they still can.

### E46-S02 — Triggered on submission, and by an organiser · M · 0.75d

**Acceptance**

1. A successful tier 1 submission enqueues a tier 2 run automatically.
2. An organiser can trigger one for any submission from the Entries table.
3. Concurrency is bounded by config, so forty simultaneous submissions do not start forty Docker
   builds.
4. Progress and outcome are visible per submission on the intake screen, with the failing checks
   named.
5. A run that dies leaves a recorded failure, not a submission stuck in "checking".

### E46-S03 — The team is told, either way · M · 0.75d

**Acceptance**

1. On all-pass, the team receives *"your entry is ready for evaluation"*, naming the commit that
   was checked.
2. On any failure, the team receives the **named problems and what to do about each** — not a
   score, not a judgement, and never a hint about how it would be scored.
3. `UNKNOWN` checks are reported as "could not be checked", distinctly from failures, with a note
   that an organiser has been told.
4. Re-submitting reruns the checks and sends a fresh result; the team is never left with a stale
   verdict.
5. Delivery state per team per run is recorded, so a team who was never told is visible rather
   than a silent gap — the `token_delivery` pattern, reused.
6. No email is sent for a submission an organiser made on the team's behalf without a contact
   address, and that is recorded as a failure to notify.

---

## E47 — A token an organiser can hand over

*Specified both ways so the decision in II.4 can be made without re-planning.*

> **Decision: both options are built.** (a) — `POST /submissions/teams/:id/reissue` with a
> required reason, the replace-a-code form, and `submissions.token_reissued`. (b) — decided by
> the product owner on 2026-09-25 and recorded in **ADR 0005**: tokens are sealed with
> `TOKEN_REVEAL_KEY` (AES-256-GCM, bound to the row) beside the hash, revealed only by an admin
> through `POST /submissions/tokens/:id/reveal` (audited before the plaintext is opened, behind
> its own ceiling), purged at lock and at revocation, and reported as unavailable — never
> failed — on a deployment without the key. Verification still uses the hash alone.

### E47-S01 — Option (a): reissue and display once · S · 0.5d

**Acceptance**

1. An organiser can reissue a team's token from the Entries or Delivery surface: the old one is
   revoked and the new plaintext is displayed **once**, exactly as bulk issue already does.
2. The screen states plainly that the previous code has stopped working.
3. Reissue is audited with actor, team and reason.
4. Nothing is stored recoverably; `access_token` keeps only the hash.

### E47-S02 — Option (b): encrypted at rest, revealed under audit · M · 1.5d

**Acceptance**

1. The plaintext is encrypted with a key from the environment, registered with the redactor, and
   stored beside the hash. The hash remains the only thing used for **verification**.
2. Reveal is **admin-only** and writes an audit event with actor, team and timestamp before the
   plaintext is returned.
3. The ciphertext is **purged when the intake window locks**, and a test proves it.
4. The reveal endpoint is rate limited (E41) and never appears in a log line.
5. A deployment without the key still works: tokens are issued and verified, and reveal reports
   that it is unavailable rather than failing.
6. The risk accepted is stated in an ADR, because this is a deliberate weakening of E17's design
   and the next reader must find the reasoning rather than the code alone.

---

## E48 — Loose ends this review surfaced

*Small, real, and each found while reviewing the four modules.*

### E48-S01 — An organiser can rename a team · S · 0.25d

**Acceptance**

1. `PATCH /api/v1/submissions/teams/:id` for display name and contact, organiser-only, audited.
2. An edit control wherever a team is listed to an organiser.
3. The name collision check applies, naming the clash.
4. Submissions keep the name they were entered under; a rename is not retrospective.

### E48-S02 — `@crucible/events` either publishes or goes · S · 0.25d

> **Decision: deleted.** No publisher ever existed; every cross-module need has been met by a
> published view or a port. P12.1 in the principles records when it comes back.

**Acceptance**

1. Fourteen event names have existed with no publisher since E01. Either a publisher is wired and
   one event is emitted and tested, or the package is deleted.
2. Whichever is chosen is recorded, so the next reader does not rediscover it.

### E48-S03 — The public-route allow-list is re-pinned · S · 0.25d

**Acceptance**

1. Every route E44 adds is added to the P8.1 allow-list **with a reason**, and the coverage test
   pins it.
2. A test asserts no endpoint returning participant or team lists is public.
3. The allow-list and the rate-limit table are checked against each other: a public route with no
   budget fails the build (E41-S02 acceptance 6).

---

## E49 — Discord as the delivery channel, email as the recorded fallback

*Added 2026-09-25 at the product owner's request. Four decisions taken: keep email as the
fallback; DM the team contact (not a channel per team); collect the Discord identity at
registration; the event has one dedicated Discord server the bot lives in.*

### E49.0 The reasoning, recorded

Discord is where the participants already are, and a DM reaches a team faster than an inbox
they are not watching at 02:00. Two facts shape the design rather than the preference:

1. **A bot can DM only a user who shares a server with it and has not closed DMs.** So the
   identity collected is resolved against the event server's members at registration — a
   username the bot cannot find is a person the bot cannot DM, and the form says so then, not on
   the night. And a DM that is refused anyway falls back to email, **recorded** as a fallback,
   never silently.
2. **The registration link cannot go by Discord.** It proves control of an address the roster
   already holds (II.2); the roster holds no Discord identity until the person registers. So the
   link stays on email, and everything after it — the code, the pre-flight outcomes — goes to
   Discord when the team has one.

Nothing above the mail port changes shape. Templates, delivery records and pre-flight notices are
untouched; the port learns a second address and a second outcome.

### E49-S01 — One port, two channels · M · 0.75d

**Acceptance**

1. `MailMessage` carries an optional `discordUserId` beside `to`; `MailResult` names the
   `channel` that delivered (`discord` or `email`) and, when it fell back, why Discord refused.
2. A Discord adapter sits beside Resend and the recording adapter: bot token from the environment,
   validated at boot, registered with the redactor (P8.3); 15 s timeout, three retries with
   backoff on transient failures, a breaker (P12.2). A refused DM (closed DMs, unknown user, not
   in the server) is **REJECTED**, never retried, and hands off to the email adapter in the same
   call.
3. Idempotent: a retry after a timeout cannot deliver twice (Discord's message nonce, enforced).
4. A message longer than Discord's limit is split at line boundaries, never truncated.
5. `token_delivery` and `preflight_notice` record the channel. The delivery panel shows it, and a
   fallback reads *"Discord refused (DMs closed); sent by email"* — the team was reached, and the
   organiser knows how.
6. No bot token, or `feature.notify.discord` off: everything goes by email exactly as today.

### E49-S02 — The Discord identity, collected where it can be checked · M · 0.75d

**Acceptance**

1. Registration asks the registrant for their Discord **username** (optional) and resolves it
   live against the event server's members. Found: the display name is confirmed and the user id
   is what is stored. Not found: *"not in the event server — join it first"* with the invite
   (`event.discord_invite_url`, config), and registration proceeds by email.
2. The resolved id becomes the team's contact Discord id at confirmation, in the same transaction
   as everything else (E44-S03). The submission code is DMed; if that fails, it is emailed, and
   the Done screen says which happened.
3. The roster can carry a Discord id for organiser-loaded participants: an optional `discord`
   column on import (username, resolved when a bot is configured; otherwise stored as given and
   flagged), and a field on the People tab. Setting a team's point of contact carries the
   contact's Discord id to the team, as it already carries the address.
4. No Discord identity is ever listed or searched from a public page (II.1): the lookup returns
   one name for one exact username, inside a registration link's scope.
5. A Discord id is personal data like an address: absent from every log line and every audit
   payload.

### E49-S03 — The event server · S · 0.25d

**Acceptance**

1. `DISCORD_GUILD_ID` names the event server; the bot must be a member, and boot logs — without
   the token — whether it is. The health page shows whether Discord delivery is live.
2. The bot needs only *Send Messages* and *Create DMs*; member search uses the REST endpoint and
   needs no privileged intent. This is stated in the deployment notes so nobody grants more.

---

## E50 — End to end: the event as one system

*A senior-architect pass over the whole event narrative — set up, roster, QR registration,
calibrate, submit, chase, deadline, two runs, one ranking — walked against the running app on
2026-09-26. What held is not listed; what did not is, with what was done.*

### E50-S01 — What is evaluated is what was locked · S · critical

**Found.** `scanService` read `locked_commit_sha` from the view and never used it; `withClone`
had no way to check out a commit. Every evaluation cloned the default branch's HEAD on the
night. A team that pushed after the deadline would have been judged on the push, and the receipt
that promised "this exact commit is what will be evaluated" was not true.

**Done.** `withClone` takes `commit`; the scan and the probe pass the locked sha once it exists
and HEAD before (which is what pre-flight should see). A scanner test with a real repository
proves the checkout; an integration test proves a post-deadline file is not in the scan.

### E50-S02 — One ranking from two runs · M

**Found.** Each run was ranked alone and the two only compared (E06-S06 refused to average so
that disagreement stays visible). The product owner's event ends with one list.

**Done.** `POST /scoring/cohorts/:cohortKey/final` combines the two STORED rankings — weighted
mean per submission (`scoring.run_weights`, equal by default), the same tie rule as each run,
the cut band from the final rank — and every row carries both composites, the delta, and a
`disagreement` mark under the variance report's own two conditions, so averaging cannot hide
what E06-S06 was protecting. A submission scored in only one run keeps that composite and says
so. Stale when either run is re-ranked afterwards. A page, a CSV, and per-run links to the
evidence. The review and shortlist workflow stays per run, deliberately: it is the record of
human decisions against the evidence, and the final list is what is published from it.

### E50-S03 — Incomplete is evaluable · S

**Found.** Tier 1 refused an entry with no README or fewer than 50 written lines (E45-S02). The
product owner wants every submitted entry evaluated, incomplete or not — and Part V.4 already
said nothing after intake is a gate.

**Done.** Both became the pre-flight **Substantive code** check: a FAIL with what to add, told to
the team, fixable until the deadline, and never a refusal. Tier 1 keeps only what an entry
cannot be evaluated without: a reachable repository and a build declaration that points at
something.

### E50-S04 — Who is not there yet, and telling them · M

**Found.** Nothing listed a registered team with no entry, and nothing reminded anybody.

**Done.** `GET /submissions/reminders` lists teams that have not submitted and teams whose entry
has unfixed pre-flight problems, each with its last reminder; `POST` reminds one or all through
the same port (Discord first, email fallback), recorded per team, from a versioned template that
carries the deadline and the submit link. The intake page shows it as *Not there yet*.

### E50-S05 — QR codes for the two participant pages · S

**Done.** *Links for participants* on the intake page: the configured register and submit URLs
(the same ones the emails carry) as QR codes generated in the browser, copyable, printable; an
admin can set both to this origin in one click when unconfigured. Event settings now return the
public URLs.

### E50-S06 — Phones · M

**Found.** No responsive rule anywhere; a fixed header row; tables wider than a phone.

**Done.** A signed-out visitor sees a header with only *Register* and *Submit* (E44-S04.1 at
last); the staff nav wraps; every table scrolls in its own box; inputs at 16 px on phones so iOS
does not zoom; print styles for the QR page. A mobile-viewport E2E asserts no sideways scroll on
either participant page.

### E50-S07 — Edge headers · S

**Done.** Content-Security-Policy (self only; inline styles because React style props) and a
Permissions-Policy at Caddy.

## E51 — Coach sheets: one page per shortlisted team

**Why.** On the night, each coach walks into a room with a team about to present and ten minutes
to make them show what they built. Everything the evaluation learned about that entry is on the
review pages, behind a sign-in, spread over five tabs, and full of numbers a coach must not read
aloud. What a coach needs is one page: who they are, what they built, whether it ran, two things
to open with, and up to five questions — each one *because* of something the run recorded, with
the file to point at.

**Rules.**
- One page per team. Five questions at most; every line a sentence (`brief()`); the "what they
  built" block is four stack names, three capabilities, three integrations.
- Nothing a coach reads carries a score, a rank or a decision. The organiser's copy (screen and
  download) carries the standing; the emailed copy and the coach's screen never do. Unit test pins it.
- Every question is derived from the record and cites it: probe outcome, discovery claims the
  code did not bear out, the weakest scored criteria with their first citation, originality above
  50% template, provenance flags, where the two runs disagreed, security observations, the
  lowest-maturity principle, a non-compliant standard — in that order of usefulness in a room.
  Nothing found → nothing asked; the sheet says so instead of inventing a fault.
- Scope is the SHORTLIST decisions of the run, or, before any decision exists, everyone inside the
  cut line. The page says which and offers the other.
- Sent by **email only**, to the coach the roster assigns, each coach their own teams in one
  message. Coaches are staff and a sheet is long; Discord is for participants (E49). Teams with no
  coach are named in the result, never skipped silently. Each dispatch is recorded (`coach_dispatch`).

### E51-S01 — Compose · M

**Done.** `review/services/coachQuestions.ts` (pure rules), `coachSheet.ts` (composer over
`teamDetail`, discovery, principles/standards, originality, final ranking, and the roster's
published views — `v_rubrics_criterion` is new for the criterion names), `coachSheetRender.ts`.

### E51-S02 — Read, print, send · S

**Done.** `GET /review/runs/:id/coach-sheets?scope=` and `…/teams/:submissionId/coach-sheet`
(reviewer+); `GET …/coach-sheets.txt` and `POST …/coach-sheets/send` (organiser). Page
`/review/runs/:runId/coach-sheets`, linked from the ranked field and the team review: single
column, phone-readable, prints one sheet per page. Template `mail.coach_sheet`.

## E52 — End-to-end assurance: the event as one journey

**Why.** Every earlier epic proved its own screen against its own seed. What none of them crossed
was a seam: the team a participant registers is the team an organiser places, is the team whose
code an admin reads back, is the team that submits, is the entry pre-flight checks, is the row
the chase list drops, is the entry the run scores. Six suites now cross those seams through the
screens, with seeding only where a model or a mail provider would otherwise be needed.

| Suite | What it walks |
|---|---|
| `lifecycle` | Room and coach → self-registration from the link → placement → code read back → submission → automatic checks → lock → a real scoring run watched to its end |
| `evaluation` | Gate passed → band decided and caveats answered → finalised → run 2 → final ranking computed and exported → coach sheets sent |
| `roles` | The API matrix for every role on 21 routes (401 signed out, 403 below rank, never 500); what each role is offered on screen |
| `resilience` | A failing API on seven pages, retry recovering, unknown addresses, a session refused mid-page, a double click, markup in a team name |
| `integrations` | A replaced code refused at once on the public form; a rename on intake seen on the roster and the form; placement on the roster seen on intake; health |
| `mobileJourneys` | Seven organiser pages at phone width: no sideways scroll, first action reachable |

**Found and fixed by the suites.**
- Intake offered issue-and-send, lock, replace, revoke, edit, bulk register, run checks, provenance
  conclusions and event setup to viewers and reviewers, who would have been refused on the click.
  Every control now appears only at the rank the API requires; the page still reads below it.
- The roster, which holds participants' addresses, was in the navigation for roles the API refuses.
- A session the API refused mid-page (expired, revoked) left the person on a page of errors; the
  route guard now subscribes to the session and returns to sign-in at once.
- A double click on *Submit entry* sent two entries before the button could disable.
- An unknown address rendered nothing; it is now a page that says so and offers the way back.
- At phone width the intake filter row did not wrap, the roster's assignment board did not stack,
  and a screen-reader-only label positioned outside its scrolling table widened every page.

### What held

Roster (people, rooms, coaches, assignment, logistics), challenges and rubrics through
publication, calibration and the gate, registration with size rule and Discord, submission with
token identity, pre-flight and its notices, lock, the batch, variance, review and shortlist.

---

# Part IV — Sequencing

The event is **3–4 October 2026**. This plan is **11–12 days** of work.

## IV.1 The order, and why

```
E41 (rate limiting)  ─┐
E42 (size rule)      ─┼─→ E44 (public registration) ─→ E46-S03 (emails)
E43 (mail adapter)   ─┘         ↑
E45 (tier 1) ───────────────────┘
E46-S01/S02 (tier 2) ─────────→ E46-S03
E47, E48 — independent, any time
```

- **E41 first**, because it is cheap and because a public write endpoint should not ship without
  a ceiling. It no longer *gates* E44 on judgement: as a breaker set above human reach, it is
  insurance rather than a precondition.
- **E43 early**, because E44 cannot finish without it and it is blocked on a decision that is not
  mine to make.
- **E45 before E46**, so the cheap refusals are in place before the expensive checks are wired.

## IV.2 If it has to fit in nine days

Ship **E41, E42, E43, E44, E45** — the public registration path, protected and enforced, with real
email. Roughly 8 days, leaving a day for the dry run.

**Defer E46 to an organiser-triggered check** using the scan, probe and discovery buttons that
already exist. Teams are then told by an organiser rather than automatically. Less good, honest,
and it does not put an untested asynchronous pipeline in front of forty teams.

**Defer E47 to option (a)**, which is half a day and no new risk.

This is the recommendation. The alternative — all seven epics, thinly tested — trades the one
property this system exists to have.

---

# Part V — What this deliberately does not build

1. **A participant directory on any public page.** II.1. The chips are the compromise.
2. **Accounts for participants or teams.** P8.2 stands; a registration link is not an account.
3. **A second team-identity path.** The token remains the only one (I.2).
4. **Tier 2 as a gate.** A readiness verdict advises; it never refuses an entry. A system that
   rejected an entry for failing its own probe would be deciding the competition with a
   harness bug.
5. **Retrospective renaming.** A submission keeps the name it was made under, because the appeal
   packet cites it.
6. **CAPTCHA or bot scoring.** Rate limiting plus roster-membership proof is proportionate for a
   closed event of 200 known people. Revisit for an open one.

---

# Part VI — Decisions required before work starts

| # | Decision | Blocks | Recommendation |
|---|---|---|---|
| 1 | **Mail provider** — Resend, Postmark, or Gmail SMTP | E43, E44, E46-S03 | Resend if a domain's DNS can be edited; Gmail SMTP otherwise |
| 2 | **Token visibility** — (a) reissue or (b) encrypted reveal | E47 | (a): half a day, no new risk |
| 3 | **Nine days or full scope** | everything | Nine days: E41–E45, defer E46 and E47-S02 |
| 4 | **Enumeration tradeoff** — may registration confirm an address is on the roster? | E44-S01 | Yes (II.3) |

## VI.1 Decisions already taken

- **Rate limiting is a circuit breaker, not a policy** (E41.0). Ceilings sit an order of magnitude
  above legitimate use, participant-facing reads are unlimited, and one flag disables the lot. No
  entrant should ever see a 429; if one does, something is looping and an organiser needs to know.

Items 1 and 3 are on the critical path. Nothing in E41 or E42 waits on any of them, so that work
can start immediately.
