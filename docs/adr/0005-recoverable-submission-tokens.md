# ADR 0005 — Recoverable submission tokens, revealed under audit

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** Product owner (decision), senior architect (controls)
- **Supersedes in part:** the "shown once, never stored" rule of E17 / migration 002

## Context

`access_token` stores a SHA-256 of every submission token. The plaintext exists once, in the
response to the call that issued it (P8.3). That is the strongest position: a database backup
is not every team's credential, and nobody — not an admin, not an attacker with the database —
can produce a token after the fact.

It has one cost, stated in the event-readiness review (II.4): an organiser cannot answer "what
is Team Alpha's code?" by looking it up. E47-S01 answered that with option (a) — revoke and
reissue, shown once — which costs nothing and stops the old code. The product owner has asked for
option (b) as well: **an admin can see a team's current code**, because on the day a team that
lost its code needs the *same* code that is in their email thread, their notes and their
teammates' hands, not a new one that invalidates all of those.

## Decision

The plaintext is **also** stored, **encrypted**, beside the hash — and only ever read back
through one audited, admin-only, rate-limited act.

1. **Encryption.** AES-256-GCM with a 96-bit random IV per token and the token's own id as
   additional authenticated data, so a ciphertext cannot be moved to another row. The key is
   `TOKEN_REVEAL_KEY` from the environment: 32 bytes, base64, validated at boot, registered
   with the redactor before any adapter runs. A key id (a hash prefix) is stored beside each
   ciphertext so a rotated key reports "unavailable" rather than failing to decrypt.
2. **Verification is unchanged.** The hash remains the only thing a presented token is checked
   against. The ciphertext is never consulted on the submission path; a deployment with the
   column emptied verifies exactly as before.
3. **Reveal.** `POST /api/v1/submissions/tokens/:id/reveal`, **admin-only** (not organiser —
   the role that issues codes is not the role that reads them back). The audit event
   `submissions.token_revealed` — actor, team, token id, timestamp — is written **before** the
   plaintext is decrypted, so a reveal that then fails is still on record. The response carries
   the plaintext for the one moment it exists; nothing logs it.
4. **Purge.** When the intake window locks, every ciphertext is deleted and the purge is
   audited with the count. After lock there is nothing to reveal and nothing to steal. A
   revoked token's ciphertext is deleted at revocation for the same reason.
5. **Degrades, never fails.** Without `TOKEN_REVEAL_KEY`, tokens are issued and verified as
   always; the ciphertext column stays null and reveal answers *"unavailable: no reveal key is
   configured on this deployment"*. A ciphertext under a key this deployment does not hold is
   reported the same way.
6. **Ceiling.** The reveal route sits behind the E41 breaker, per credential — the second limit
   in the system set for security rather than as a breaker, beside login.
7. **Kill switch.** `feature.submissions.token_reveal` turns reveal off without a redeploy;
   issuing still seals, so switching it back on loses nothing.

## Consequences

**Accepted risk — stated plainly.** Between issue and lock, a compromise of **both** the
database and the reveal key exposes every live submission code. Before this decision, the
database alone exposed nothing. The key is a second secret, held in the environment beside
`JWT_SECRET`, and the window in which it matters is the intake window — days, not the life of
the system. Within that window the exposure is bounded to what an admin could already do with
option (a): impersonate a team's submission. The tokens carry one scope, `submissions:create`,
and every use is attributed to the token id in the audit trail, so a stolen code produces a
disputable entry, not a silent one.

**What the audit trail gains.** "Who looked at this team's code, and when" becomes answerable.
Under option (a) alone it was answerable only as "who reissued it".

**What it does not change.** Teams still have no accounts (P8.2). The token is still the only
team identity (E17). Nothing on the submission path reads the ciphertext. Registration, bulk
issue and reissue seal the plaintext through the one insert point, so there is no second path
that forgets to.

**Reversible.** Drop `TOKEN_REVEAL_KEY` and run the purge: the system is back to hash-only with
no code change. The columns can stay empty indefinitely.

## Guarding it

- A test proves lock purges every ciphertext.
- A test proves verification succeeds with the ciphertext removed or corrupted.
- A test proves reveal writes its audit event before returning, and that no log line ever
  carries the plaintext.
- The rate-ceiling coverage test knows exactly one authenticated route may carry a ceiling
  (`LIMITED_PRIVATE`), so a second one has to be a decision.
