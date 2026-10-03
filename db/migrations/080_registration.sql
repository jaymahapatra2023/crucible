-- 080 — Participants register their own teams (E44).
--
-- A one-time link proves the registrant controls an address ALREADY ON THE ROSTER, which is
-- exactly the property a public endpoint needs and the only one it can have without accounts
-- (P8.2). The link token is treated like a submission token: random, hashed at rest, single-use,
-- expiring, and never stored in the clear (P8.3).
--
-- What this table does NOT hold: the draft team. Nothing is written until the registrant confirms
-- — the plan-then-confirm pattern every import in this system uses — so a link row is only ever
-- "who asked, when, and whether they finished".

CREATE TABLE IF NOT EXISTS registration_link (
  link_id        BIGSERIAL    PRIMARY KEY,
  participant_id BIGINT       NOT NULL REFERENCES participant (participant_id),
  token_hash     CHAR(64)     NOT NULL UNIQUE,
  expires_at     TIMESTAMPTZ  NOT NULL,
  -- Set when the link produced a team. A used link is refused, and the refusal says so.
  used_at        TIMESTAMPTZ,
  -- Set when the participant started again. Starting twice invalidates the first rather than
  -- leaving two live links for one person (E44-S01 acceptance 6).
  superseded_at  TIMESTAMPTZ,
  -- The team the link produced, so a re-confirm can name it (E44-S03 acceptance 7). A plain
  -- column: `team` belongs to submissions (ADR 0002).
  team_id        BIGINT,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT chk_link_used_has_team CHECK (used_at IS NULL OR team_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_registration_link_participant
  ON registration_link (participant_id) WHERE used_at IS NULL AND superseded_at IS NULL;

INSERT INTO app_config (key, value, value_type, description, module, editable, affects_outcome)
VALUES
  ('registration.link_ttl_minutes', '60'::jsonb, 'number',
   'How long a registration link stays valid (E44). Long enough to gather eight addresses, short enough that a forwarded email is not a standing credential.',
   'roster', TRUE, FALSE),
  ('event.register_url', '""'::jsonb, 'string',
   'Where the registration page lives, used in the link email (E44). Empty means the email says "the registration page" rather than guessing a URL.',
   'event', TRUE, FALSE)
ON CONFLICT (key) DO NOTHING;

/*
 * The link message. It carries a LINK, not a token: the `{{token}}`-in-exactly-one-template
 * invariant (E43) is about the submission code, and this is not it.
 */
INSERT INTO mail_template (mail_key, version, subject, body, variables, content_hash, created_by)
VALUES (
  'mail.registration_link', 1,
  'Register your team',
$BODY$Hello {{participant_name}},

You asked to register a team. This link lets you do that:

    {{link}}

What to do: open it, name your team, pick the challenge, and add your teammates by their email
addresses — each has to be on the participant list already. A team needs between {{min_size}} and
{{max_size}} people.

The link works once and expires in {{ttl_minutes}} minutes. If it has expired, start again from the
registration page. If you did not ask for this, ignore it — nothing happens unless the link is used.

If your address or a teammate's is not recognised, ask an organiser to check the participant list.$BODY$,
  ARRAY['participant_name', 'link', 'min_size', 'max_size', 'ttl_minutes'],
  repeat('0', 64), 'migration'
)
ON CONFLICT (mail_key, version) DO NOTHING;

UPDATE mail_template
   SET content_hash = encode(sha256(convert_to(subject || E'\n' || body, 'UTF8')), 'hex')
 WHERE content_hash = repeat('0', 64);
