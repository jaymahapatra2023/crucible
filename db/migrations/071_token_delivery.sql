-- 071 — Did this team actually receive the thing they need to submit? (E29-S02, E34)
--
-- A team that never got its token cannot enter, and until now nothing recorded whether the token
-- reached anybody. The organiser's only evidence was a CSV they downloaded once and a memory of
-- having mail-merged it.
--
-- What this table does NOT hold is the token. `access_token` stores a hash and the plaintext
-- exists for exactly one moment — inside the response to the request that issued it (P8.3).
-- A delivery record that carried the token would be a second, permanent copy of the credential,
-- which is the whole thing the hashing was for. Nor does it hold the address: that lives on
-- `team.contact_email`, and duplicating it here would be a second declaration that drifts the
-- first time somebody corrects a typo (P1.5 clause 6).
--
-- So it records what is left, which is the part actually in question: which token, to which team,
-- by what route, whether it went, and why not.

CREATE TABLE IF NOT EXISTS token_delivery (
  delivery_id  BIGSERIAL    PRIMARY KEY,

  -- Plain columns, not foreign keys: `team` and `access_token` belong to submissions and this
  -- record is read by intake, which resolves them at the service layer (ADR 0002).
  team_id      BIGINT       NOT NULL,
  token_id     BIGINT       NOT NULL,

  -- PREPARED is not a lesser SENT. It means a message was composed and handed to a provider that
  -- does not transmit — the operator has the text and delivery is theirs. Recording it as SENT
  -- would claim something nobody did.
  status       TEXT         NOT NULL
                 CHECK (status IN ('PREPARED', 'SENT', 'FAILED')),

  -- Which adapter produced this outcome, so a run of failures can be attributed to a provider
  -- rather than to the teams.
  provider     TEXT         NOT NULL,

  attempts     INTEGER      NOT NULL DEFAULT 1 CHECK (attempts >= 1),

  -- Redacted before it is written. A provider's error text routinely quotes the credential it
  -- was given (P8.3).
  last_error   TEXT,

  prepared_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  sent_at      TIMESTAMPTZ,
  prepared_by  TEXT         NOT NULL,

  -- A SENT delivery has a time it went; nothing else does. The two cannot disagree.
  CONSTRAINT chk_sent_has_time CHECK (
    (status = 'SENT' AND sent_at IS NOT NULL) OR (status <> 'SENT' AND sent_at IS NULL)
  )
);

-- One delivery record per token. Re-preparing the same token updates the row rather than adding
-- a second: "we tried twice" is `attempts`, not two rows that each look like the whole story.
CREATE UNIQUE INDEX IF NOT EXISTS uq_token_delivery_token
  ON token_delivery (token_id);

CREATE INDEX IF NOT EXISTS idx_token_delivery_team ON token_delivery (team_id);

COMMENT ON TABLE token_delivery IS
  'Whether each team was sent its submission token (E29-S02). Never holds the token itself.';
