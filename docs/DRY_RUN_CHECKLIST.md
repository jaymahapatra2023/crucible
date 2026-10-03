# Crucible — dry-run checklist for 3–4 October 2026

Run this in order, once, with the real services, no later than **T-3 days**. Every step names
what "done" looks like, so whoever runs it does not have to judge. Tick the box only when the
named thing happened.

Conventions:

- **Admin** = a signed-in user with the `admin` role. Some steps say *admin only*; an organiser
  cannot do them.
- **Config** is set through the API. Sign in, then:
  `curl -X PATCH $API/api/v1/platform/config/<key> -H "authorization: Bearer $JWT" -H "content-type: application/json" -d '{"value": <json>}'`
  Flags: `PATCH /api/v1/platform/flags/<key>` with `{"enabled": true|false}`.
- Anything below that fails is a defect or a misconfiguration to fix **before** moving on. The
  order matters: later steps assume the earlier ones held.

---

## Part A — T-7 days: environment and configuration

*The host itself — EC2, RDS, images, the deploy script — is `docs/DEPLOYMENT_AWS.md`, section 2.
Do that first; this part assumes a running stack.*

### A1. Environment (the `crucible/env` secret; `deploy.sh` writes it to `.env` on the host)

- [ ] `DATABASE_URL`, `JWT_SECRET` set; `pnpm migrate` reports **87 total** and nothing pending.
- [ ] `MAIL_PROVIDER=resend`, `MAIL_API_KEY`, `MAIL_FROM` set. The API **refuses to boot** if
      `resend` is chosen without the other two — that refusal names the missing one.
- [ ] `DISCORD_BOT_TOKEN` and `DISCORD_GUILD_ID` set. Boot refuses a token without a guild.
- [ ] `TOKEN_REVEAL_KEY` set (`openssl rand -base64 32`). Codes issued **before** this is set have
      no stored copy and cannot be revealed later — set it before issuing anything.
- [ ] `ANTHROPIC_API_KEY` or `LLM_CLI_BINARY` set; `/health` page shows the provider **available**.
- [ ] Boot log contains `discord delivery configured; email is the recorded fallback`.

**Done when:** the Health page (`/health`) shows *HEALTHY*, *Team delivery: mail: resend+discord;
Discord DM: live*, the model provider available, and *No ceiling has refused a request*.

### A2. Discord bot

- [ ] Bot created in the Discord developer portal; **invited to the event server** with the
      *Send Messages* permission only. No privileged intents — the username lookup uses the REST
      member search.
- [ ] `event.discord_invite_url` config set to the server's invite link.
- [ ] Every participant is told, in the invitation: *join the event server before you register,
      and allow DMs from server members.* A person who has not done both gets email instead — that
      is fine, but they should know why.

### A3. Event settings (Intake page, *Event setup*, and config)

- [ ] **Evaluation date** = `2026-10-04`.
- [ ] **Event window** = `2026-10-03T12:00:00-04:00` → `2026-10-04T12:00:00-04:00`. Note the
      `-04:00`: October is EDT, not EST. This window drives provenance classification.
- [ ] **Intake window** (Intake page, *Submission window*) opens and closes at the same times.
- [ ] `event.register_url` = the public URL of `/register`; `event.submit_url` = the public URL of
      `/submit`. Until set, emails say "the submission page" instead of a link. Intake page →
      *Links for participants* shows both as **QR codes**; as admin, *Use this address for both*
      sets them in one click. **Print this page** for the room.
- [x] `roster.min_team_size` = 3, `roster.max_team_size` = 8 — **confirmed as the official rule
      on 2026-09-25.** Registration refuses outside them; organisers can still hold an
      out-of-bounds team, and the roster readiness checklist names it.

### A4. Flags to confirm (`GET /api/v1/platform/flags`)

- [ ] `feature.http.rate_limit` **on**. (The E2E seeds turn it off in a dev database; the
      production database must have it on — it is the loop-breaker, not a policy.)
- [ ] `feature.preflight.enabled`, `feature.preflight.auto_run`, `feature.preflight.notify` on.
- [x] `feature.preflight.discovery` **on — decided 2026-09-25.** Roughly seven model calls per
      submission at submit time; it also needs `feature.discovery.enabled` on (it is). Set it on
      the production database too: `PATCH /api/v1/platform/flags/feature.preflight.discovery`
      with `{"enabled": true}`, admin only.
- [ ] `feature.notify.discord` on; `feature.submissions.token_reveal` on.
- [ ] `feature.submissions.self_service` on (teams submit with their own token).
- [ ] `feature.probes.enabled` on, **and Docker is reachable on the host** (A6 proves it).
- [x] `submissions.artifact_hosts` **widened — decided 2026-09-25**: the four code hosts plus
      `bitbucket.org, codeberg.org, youtube.com, loom.com, vimeo.com, docs.google.com,
      drive.google.com, notion.site, figma.com, huggingface.co`. Set the same list on the
      production database (`PATCH /api/v1/platform/config/submissions.artifact_hosts`). Redirects
      are still refused, so a `youtu.be` short link or a Drive link that bounces to a consent page
      is refused **naming the destination** — teams should paste the final address.

### A5. Challenges and rubrics

- [ ] Every challenge is **OPEN** with its brief uploaded and extracted (Challenges page shows
      *EXTRACTED* per document, not a summary).
- [ ] Every challenge's rubric is generated, reviewed, approved, **frozen and published**.
      Submission is refused for a challenge whose rubric is not published — teams are entitled to
      read the standard first. The Submit page links the published rubric once a challenge is
      chosen; open that link signed out and confirm it renders.

### A6. Roster

- [ ] Participants imported (`full_name, email`, optional `organisation, phone, discord,
      team_name`). The People tab shows every name; any `discord` value the bot could not find in
      the server shows **(not found in server)** — chase those people to join.
- [ ] Rooms and coaches loaded; the roster readiness checklist (Roster page) is **green** or every
      red line is one you accept (e.g. teams not yet formed, because they will self-register).

---

## Part B — T-3 days: the dry run, with real services

Use a **real** participant address you control and a **real** Discord account in the server. Do
not skip a step because it "obviously works" — the point is to see each channel deliver.

### B1. Registration by a participant

- [ ] Open `/register` signed out. Enter your roster address. The page says a link was **emailed**
      (it never says who is on the roster). The email arrives from `MAIL_FROM` within a minute.
- [ ] Open the link. The page shows *Registering as \<your name\>*, the open challenges, and
      **3–8**. There is no list of participants anywhere.
- [ ] Name the team. A name that differs only by case or punctuation from an existing team is
      refused **before** you submit, naming the clash.
- [ ] Add two teammates by exact address. Each appears as a chip with the matched name. A wrong
      address says *not on the roster*; an address already on a team names that team.
- [ ] Enter your Discord username and press **Check**. It says *Found: \<display name\>*.
      (If it says *join the event server first*, do that with the invite and check again.)
- [ ] Register. The Done screen says the code was **sent to you on Discord**. The DM arrives from
      the bot, headed with the team name, containing a `crs_` code and the submit link.
- [ ] Intake page, *Getting teams their code*: the team shows **Discord DM · SENT**.
- [ ] Open the registration link again: it is refused (*used a moment ago / start again*).

### B2. The email fallback

- [ ] Register a second team with a teammate whose Discord DMs are **closed** (Discord →
      Settings → Privacy → *Allow direct messages from server members* off), or with a username
      that is not in the server.
- [ ] The Done screen says the code was **emailed**, and *Discord: …* names the reason.
- [ ] Delivery panel shows **Email (Discord refused)** for that team, with the reason in
      *What went wrong*. The email arrived.

### B3. Submission and pre-flight

- [ ] Open `/submit` signed out. Paste the code from B1. Within a second the form says
      **Submitting as \<team\>** — there is no team-name field. A made-up code says *not valid* at
      the field, before anything is sent.
- [ ] Submit a **real, public repository** shaped like an entry (README, a Dockerfile or a start
      command, real code). The receipt says *Commit: not locked yet — your repository was read
      successfully*.
- [ ] Intake page, *Entries*: the row shows **Queued**, then **Checking…**, then a verdict within
      a few minutes. Reload to see it move; the page does not poll.
- [ ] Verdict **READY**: the team receives *your entry is ready for evaluation* by Discord DM (or
      email), naming the commit. *Team told* shows on the row.
- [ ] Verdict **PROBLEMS**: the row names the failing checks; the message the team receives names
      each with *What to do*, and contains the sentence *This is not a score*.
- [ ] Verdict **Could not be checked**: this is the harness, not the team. If it says the build
      could not be attempted, **Docker is not reachable from the API host** — fix that before the
      event; forty submissions will all say the same thing otherwise.
- [ ] Submit a repository with a committed secret (an `AKIA…` string in a source file). The
      pre-flight says **Committed secrets** with the file and line and the word ROTATE — and never
      the value. Remove the file from the test repo afterwards.
- [ ] Submit again from the same team. The receipt shows **version 2**; the entries row shows the
      new commit's checks; the earlier result is superseded, not duplicated.

### B4. Organiser surfaces (signed in as organiser)

- [ ] *Entries* filters and sorts on the server; the pager says *1–N of M* with the real total.
- [ ] *Run checks* / *Run again* queues a pre-flight for a chosen entry; pressing it twice says
      *already queued*.
- [ ] Rename the dry-run team from its token row (**Edit team #…**). A colliding name is refused
      naming the clash; the entry keeps the name it was made under.
- [ ] **Replace this team's code** with a reason: the panel shows the new code once and says *the
      previous code has stopped working*. The old code is refused at `/submit`.
- [ ] *Check my entry* on `/submit` with the new code lists the entry with a plain remedy or
      *accepted*.

### B5. Admin-only

- [ ] Signed in as **admin**, the token row shows **Reveal**. Press it: the current code appears,
      headed *read back under your name*. The token's audit trail
      (`GET /api/v1/governance/audit/access_token/<tokenId>`, organiser or above) has a
      `submissions.token_revealed` event with your email, the team, and the time — and not the code.
- [ ] Signed in as organiser, there is **no** Reveal button.

### B6. Safety ceilings

- [ ] Health page shows *No ceiling has refused a request*. If anything tripped during the dry
      run, find out what looped before the event; a human should never reach a ceiling.

### B7. Clean up

- [ ] Remove the dry-run teams' entries and teams, or leave them and exclude the challenge from the
      cohort on the night — decide now and write it down. Revoke the dry-run codes.

---

## Part C — T-1 day: readiness

- [ ] `GET /api/v1/platform/readiness/<cohortKey>` — every line PASS, or each FAIL is one you have
      decided to accept, in writing.
- [ ] Roster readiness (Roster page) green: everyone assigned, every team 3–8, every team with a
      room, a coach, and a contact address.
- [ ] Calibration gate recorded (Calibration page) — an uncalibrated system must not rank.
- [ ] Health page HEALTHY; scheduled tasks show no last error; Discord DM *live*.
- [ ] `event.dry_run_lead_days` — confirm the value matches when you actually ran Part B.

---

## Part D — event day

**12:00 EDT, 3 October — window opens**

- [ ] Intake page shows the window **OPEN**. `/submit` signed out shows *OPEN — entries are being
      accepted*.
- [ ] First real submission arrives: entries row moves Queued → Checking → verdict; the team's
      channel shows *team told*.

**During the window** (check every few hours)

- [ ] *Needs chasing* on the Intake page is empty, or every team on it has been walked to (room
      and coach are beside the name).
- [ ] *Not there yet* (Intake page): registered teams with no entry, and entries with unfixed
      problems. **Remind all** two hours before the deadline; the row shows when each was last told.
- [ ] Delivery panel: no team at **FAILED** without a reason you have acted on. A **team NOT told**
      on an entries row means a pre-flight result nobody received — tell them.
- [ ] Health page: no ceiling tripped. If one has, something is looping — find it before a team is
      affected.

**12:00 EDT, 4 October — window closes**

- [ ] Wait for the last pre-flight runs to settle (no *Checking…* rows), then **Lock the window**
      from the Intake page. Locking records every entry's HEAD commit, purges every stored code
      copy (Reveal now says *purged when the intake window locked*), and stops re-validation.
- [ ] The lock report lists any repository whose HEAD could not be read. Those teams' commits are
      recorded as null — decide with them, now, before evaluation.

**Evaluation**

- [ ] Start **run 1** from the Scoring page with the cohort key from Part C. It scans and builds
      the **locked** commit of every entry (E50-S01); watch the batch page, which survives a reload.
- [ ] Rank run 1 (Ranking page). Then start **run 2** with the same cohort key and rank it.
- [ ] Scoring page → *Final ranking (both runs)* → **Compute final ranking**. One list: the
      weighted mean of the two runs (`scoring.run_weights`, equal unless you change it), both
      composites beside it, rows where the runs disagree marked for a human. Export the CSV.
- [ ] Review the evidence on the Review page (per run) for the marked rows and the cut band;
      nothing there can mark a team as selected — that is deliberate, and it is the committee's act.
- [ ] If you re-rank a run, the final page says it is stale; recompute before publishing.
- [ ] Once the committee has recorded its SHORTLIST decisions (or, if it has not yet, using
      *inside the cut line*): Review page → **Coach sheets** → read one, then **Email each coach
      their teams**. The result names any shortlisted team with no coach on the roster; assign one
      on the Roster page and send again (a coach only ever receives their own teams). Print the
      set as a fallback; the coach's copy carries no score, rank or decision.

---

## If something fails

| Symptom | Where to look |
|---|---|
| Email never arrives | Delivery panel *What went wrong*; Resend dashboard for the provider ref shown there |
| DM never arrives, panel says *Discord refused* | The reason is on the row; usually closed DMs or not in the server — the team gets email regardless |
| Every pre-flight says *could not be checked: build could not be attempted* | Docker not reachable from the API host; `feature.probes.enabled` on a host with no Docker |
| A team says their code "doesn't work" | Token panel: revoked? unbound? Reveal (admin) to compare, or replace it with a reason |
| Entries row stuck at *Checking…* for over 30 minutes | It will be recorded FAILED by the next tick and the team told; the ledger run for it shows which check hung |
| A 429 reached a participant | Health page names the route and count; raise `http.ceiling_*` in config or set `feature.http.rate_limit` off — no deploy needed |
