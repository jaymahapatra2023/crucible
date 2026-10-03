# Crucible — roster, rooms and coaches

Everything that has to be true before a team can submit, and none of which the system currently
knows: who the participants are, which team each is on, where that team sits, and who coaches
them.

Written against the implementation verified at 2,101 tests across 121 files.

---

# Part I — What already exists, and what that changes

Three things are further along than they look, and one thing in the request would undo work
already done.

## I.1 A team is already a record

E17 made `team` an entity with a stable id, a display name, a contact, and a derived
`normalised_name`. A submission takes its team from the **verified token**, not from typed text,
and the uniqueness rule is one current submission per `(team, challenge)`.

So this work **extends** `team` rather than introducing it. Teams stop being created as a
side effect of issuing a token and start being created during roster setup; token issue then
attaches to a team that already exists, which the `--teamId` reissue path already supports.

## I.2 "Each team selects their team name" would reintroduce a closed defect

The request offers two options for submission identity: the team picks its name from a list, or a
unique code is emailed to each team.

**The first is the defect E17 removed.** Team identity used to be a string typed into a form, and
three consequences followed: "Night Shift" and "The Night Shift" were different teams and neither
knew it; a team that corrected its spelling started a second lineage; and a token was labelled
with a name nothing reconciled against the form, so the audit trail could not answer whether a
team submitted with their own credential. Those were G4, G13 and G14.

**The second is already built.** The unique code *is* the submission token: 192 bits of entropy,
SHA-256 at rest, revocable in real time, bound to exactly one team, and refused if the binding is
missing. E20 issues them in bulk and exports `team_name,contact_email,token,status`.

What is missing is **delivery**, and only delivery. Recommendation: keep the token as the sole
identity, and treat "email it" as its own scoped piece (E29-S02) rather than as a reason to add a
second, weaker identity path.

## I.3 There is no mailer

No SMTP adapter, no mail dependency, nothing. Getting tokens to teams is not blocked on building
one — the export file exists and an organiser can mail-merge it today — so the mailer is
deliberately optional and sequenced last.

---

# Part II — Design decisions, and why

## II.1 Participants are records, not users

The same choice P8.2 makes for teams, for the same reason: 200 accounts for one weekend is all
risk and no benefit. A participant has no password and nothing to sign in to.

But a participant list is **personal data**, which teams' contact addresses only barely were:

- soft delete with a reason code, `GDPR_ERASURE` included (P7.4);
- addresses registered with the log redactor and never written to a log line (P8.3);
- reachable on no public route — participants are organiser-only, unlike the published rubric.

## II.2 Rooms and coaches are logistics, and are modelled as such

`team.room_id` and `team.coach_id` are ordinary nullable foreign keys, editable, with an audit
event on every change. **Not** versioned chains.

P7.1 reserves append-only history for state an appeal turns on. Where a team sat does not decide
a score. Recording every room swap as a superseded row would add a table and answer a question
nobody asks; the audit event answers the one they do — who moved them, and when.

## II.3 One fairness consequence that is not logistics

A coach who is also a **reviewer or judge** is a conflict of interest: they would be deciding
about work they helped produce. Coaches are not participants and are not Crucible users, so
nothing currently connects the two — which means nothing currently detects it either.

E29-S03 adds the check by email match, as a warning with a named person rather than a refusal:
the same person may legitimately hold both roles at a small event, and the answer is that
somebody decided so knowingly.

## II.4 Enforced at the database, or advisory, and the difference matters

**Enforced**, because a violation is incoherent rather than merely untidy:

- a participant is on **at most one team** — otherwise "who submitted this" has two answers;
- a room holds **at most one team** — two teams in one room is a problem in the physical world.

**Advisory**, surfaced as readiness checks rather than refusals:

- team size within bounds — a half-formed team at 9am on the day is normal, and a system that
  refused to record it would be describing a world that does not exist;
- coach load — six teams to one coach is a judgement, not an error;
- every team has a room and a coach.

The rule this project keeps: refuse what cannot be true, report what merely should not be.

## II.5 One event, unscoped

There is no `event` entity and this work does not add one. A participant list, a room list and a
coach list are all per-event, so a second event would want scoping — and building it now is
speculative generality with a real cost in every join. The note is here so the omission is a
decision rather than an oversight.

---

# Part III — The epics

## E27 — People, rooms and coaches as records

**Goal.** Load the three lists before the event, and edit any of them afterwards.
**Size:** 2 d.

### E27-S01 — Participants, bulk then editable · M · 1d

*As an organiser, I want to load 200 registered participants once and correct them afterwards.*

**Acceptance**

1. A `participant` table: stable id, full name, email (unique, case-insensitive), optional
   organisation and phone, soft delete with a reason code.
2. Bulk import from CSV, reusing E20's pattern exactly: **plan first, write nothing**, per-row
   outcomes, and **the whole file refused if any row cannot be acted on**.
3. The import recognises a participant who already exists by email and reports them as existing
   rather than creating a duplicate.
4. Every field editable afterwards, with the change recorded in the audit trail. *(The API
   landed in E27; the screen that reaches it landed in E31, along with adding one by hand.)*
5. Removing a participant is a soft delete carrying a reason; an assigned participant cannot be
   removed without being unassigned first, and the message says so.
6. No participant data on any public route, and no address in any log line.

### E27-S02 — Rooms and coaches · S · 0.5d

*As an organiser, I want the venue and the coaching roster loaded before the day.*

**Acceptance**

1. A `room` table (label, building or floor, capacity) and a `coach` table (name, email,
   optional organisation), both bulk-importable through the same path as participants.
2. Both editable; a room may be taken out of use without being deleted, because a room that was
   used yesterday still needs to exist. *(Screen delivered in E31.)*
3. A coach is explicitly **not** a participant: separate table, no membership, and a test that
   proves one cannot be assigned to a team as a member.

### E27-S03 — A team has a place and a coach · S · 0.5d

*As an organiser, I want to move a team to a different room or give them a different coach.*

**Acceptance**

1. `team.room_id` and `team.coach_id`, both nullable — a team exists before its logistics do.
2. A room is allocated to at most one team, enforced by the database; attempting a second says
   which team already has it.
3. Reassigning either records an audit event naming what changed, from what, by whom.
4. Room and coach appear wherever a team is identified to an organiser: the intake dashboard and
   the team review page. *(Reassignment through the app landed in E31's Logistics tab; both
   screens named here landed in E32, through `logisticsPort`.)*

---

## E28 — Assigning 200 participants to teams

**Goal.** Make the assignment of 200 people to ~40 teams an afternoon's work, not a week's.
**Size:** 3 d. **This is the epic the request is really about.**

### E28-S01 — Membership · M · 0.5d

**Acceptance**

1. A `team_member` table linking a participant to a team, with an optional role marking the
   point of contact.
2. A participant is on **at most one team**, enforced by a unique index rather than by a service.
3. Unassigning is permitted and recorded; it is not a delete of the participant.
4. A team's `contact_email` defaults from its point of contact and stays editable, so the value
   E17 requires is not a second thing to type.

### E28-S02 — The assignment surface · L · 1.5d

*As an organiser with 200 unassigned people, I want to assign them without scrolling.*

**Acceptance**

1. Two panes: unassigned participants, and teams with their current rosters.
2. **Keyboard-first.** Type to search, Enter to assign to the selected team, and the search box
   keeps focus. Drag-and-drop is offered as well but is not the fast path — at 200 rows a mouse
   is slower and misdrops are silent.
3. **Unassigned count is the primary signal**, visible at all times, because it is the only
   number that says whether the job is done.
4. **Undo the last assignment**, without a confirm dialogue. Misassignment at this volume is
   certain, and a dialogue on every action costs more than the mistake.
5. Search matches name and email, and filters by assigned or unassigned.
6. Nothing is paginated away silently: the count is the real count, and a bounded list says so
   (P5.7).
7. Creating a team from this screen, because a team that does not exist yet is the commonest
   reason an assignment cannot be made. The person at the top of the search is offered as its
   first member and point of contact; a name that is an existing team after normalisation is
   refused by name; and the new team is selected as soon as it appears, so the next Enter does
   not go to the previous selection. *(Built in E30, not with the rest of E28.)*

### E28-S03 — Assign in bulk, where the answer is already known · M · 0.5d

*As an organiser, I want participants who already told us their team to arrive assigned.*

**Acceptance**

1. An optional `team_name` column in the participant CSV creates the team where it does not
   exist and assigns the participant to it, in one pass.
2. Team names are matched by the **same normalisation** `team_normalise` already provides, so a
   spreadsheet with "The Night Shift" and "night shift" produces one team, not two.
3. The plan states, per row, which team the participant would join and whether that team would be
   created — before anything is written.

### E28-S04 — What is not ready · S · 0.5d

**Acceptance**

1. Readiness checks, alongside the existing nine: participants unassigned, teams below or above
   the size bounds, teams with no room, teams with no coach.
2. Each names the specific teams or people, not a count. "7 unassigned" is a complaint;
   naming them is a worklist.
3. `UNKNOWN` where a list was never loaded, distinct from zero — the same rule the event-window
   check keeps.

---

## E29 — Getting the code to the team

**Goal.** Every team holds a working token before the window opens.
**Size:** 1.5 d, of which the mailer is 1 d and is optional.

### E29-S01 — Issue for every team that has none · S · 0.5d

*As an organiser, I want one action that covers the teams I have, not a file I have to build.*

**Acceptance**

1. Issue a submission token for every team with no active token, in one transaction, returning
   every plaintext once — E20's delivery file, without the CSV on the way in.
2. Teams that already hold an active token are reported as such and are not reissued, because a
   second live token per team is two answers to "who submitted".
3. The stranded-teams warning E20 added becomes actionable from the same surface.

### E29-S02 — Delivery · M · 1d · OPTIONAL

*As an organiser, I want each team to receive their code without a mail merge.*

**Acceptance**

1. An outbound mail port with one adapter, the only file permitted to speak to an SMTP server —
   the same shape as the LLM provider contract.
2. Credentials from the environment, registered with the redactor; **no address and no token in
   any log line**, including inside a captured stack.
3. One message per team to its point of contact, carrying the token, the submission link and the
   published rubric link.
4. Delivery is recorded per team — sent, failed with a reason, or not attempted — and a failure
   is visible as a team who cannot submit rather than as a silent gap.
5. **Sending is never in an evaluation's call path.** The export file remains the fallback and
   the mailer is a convenience over it, not a dependency.

### E29-S03 — The conflict a roster makes visible · S · 0.25d

*As an organiser, I want to know if a coach is also judging.*

**Acceptance**

1. A check matching coach addresses against Crucible users holding `reviewer` or above.
2. A **warning naming the person and the teams they coached**, not a refusal — the same person
   may legitimately hold both roles, and what matters is that somebody knew.
3. It appears on the readiness report, so it is seen before the event rather than during an
   appeal.

---

# Part IV — Sequencing

```
E27-S01 participants ──┬── E28-S01 membership ── E28-S02 assign surface
E27-S02 rooms/coaches ─┤                              │
E27-S03 team logistics ┘                         E28-S03 bulk assign
                                                      │
                                                 E28-S04 readiness
                                                      │
                                            E29-S01 issue for all teams
                                                      │
                                       E29-S02 mailer (optional) · E29-S03 conflict
```

E27 is three independent imports and can be built in any order. E28-S02 is the largest single
piece and the one worth most care. E29-S02 is the only item that can be dropped entirely without
stranding anything.

**Total: 6.5 d, of which 1 d is optional.**

---

# Part V — What this deliberately does not build

- **An `event` entity.** One event, unscoped. See II.5.
- **Participant self-service.** No accounts, no logins, no "edit my details" page. 200 account
  recoveries is the problem P8.2 exists to avoid.
- **Team self-naming at submission time.** See I.2. The name is editable by the team on the
  submission form already, and correcting it renames the team they are rather than creating one.
- **Scheduling, catering, badges, check-in.** A roster is not an event-management platform, and
  each of those is a separate product with its own data.
- **Room capacity enforcement.** Capacity is recorded and surfaced; a team of six in a room for
  four is a decision somebody makes on the day.
