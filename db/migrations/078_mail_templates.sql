-- 078 — Mail templates in the database, and a provider reference on delivery (E43).
--
-- P3.3 puts prompt templates in the database so an operator can tune wording without a redeploy,
-- and the same argument applies with more force to an email forty teams will read: a typo in the
-- token message is a support conversation per team.
--
-- A SEPARATE table, deliberately. `llm_prompt_template` has the right shape, but it is keyed to
-- `llm_call_registry`, and registering an email there would make the LLM call registry, its
-- audit and `listProviders` all describe a model call that never happens. Same versioning
-- discipline, same `{{variable}}` substitution (moved to `lib/` so both can use it), different
-- table because they are different things.
--
-- Supersede, never edit: a message a team already received was produced under the version that
-- was active then, and the record of what was said has to survive rewording (P7.1).

CREATE TABLE IF NOT EXISTS mail_template (
  template_id   BIGSERIAL    PRIMARY KEY,
  mail_key      TEXT         NOT NULL,
  version       INTEGER      NOT NULL CHECK (version >= 1),
  subject       TEXT         NOT NULL CHECK (length(btrim(subject)) > 0),
  body          TEXT         NOT NULL CHECK (length(btrim(body)) > 0),
  -- Every placeholder the body and subject use, declared so a render can refuse a missing one
  -- before a team receives "Hello ,".
  variables     TEXT[]       NOT NULL DEFAULT '{}',
  content_hash  CHAR(64)     NOT NULL,
  active        BOOLEAN      NOT NULL DEFAULT TRUE,
  created_by    TEXT,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (mail_key, version)
);

-- At most one active version per key.
CREATE UNIQUE INDEX IF NOT EXISTS uq_mail_template_active
  ON mail_template (mail_key) WHERE active;

COMMENT ON TABLE mail_template IS
  'Versioned plain-text email templates (E43). The token appears in exactly one of these, ever.';

/*
 * The one message that carries a token. Every template states, in order: what happened, what to
 * do, who to ask (E43-S02 acceptance 2). Plain text, because it has to survive every mail client.
 */
INSERT INTO mail_template (mail_key, version, subject, body, variables, content_hash, created_by)
VALUES (
  'mail.token_issued', 1,
  '{{team_name}} — your submission code',
$BODY$Hello {{team_name}},

Your team is registered and this is your submission code:

    {{token}}

It identifies your team, so keep it within the team and do not share it more widely.

What to do: when your entry is ready, go to {{submit_url}} and paste the code. Your team name
will appear once it is accepted — nothing else to type.

If you lose this code, ask an organiser. It cannot be looked up; they will issue a new one and the
old one will stop working.$BODY$,
  ARRAY['team_name', 'token', 'submit_url'],
  repeat('0', 64), 'migration'
)
ON CONFLICT (mail_key, version) DO NOTHING;

UPDATE mail_template
   SET content_hash = encode(sha256(convert_to(subject || E'\n' || body, 'UTF8')), 'hex')
 WHERE content_hash = repeat('0', 64);

-- What the provider called the message, so a support question ("did it go?") can be answered
-- against the provider's own record rather than ours alone.
ALTER TABLE token_delivery ADD COLUMN IF NOT EXISTS provider_ref TEXT;
