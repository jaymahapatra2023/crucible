-- 002 — Identity and roles (P8.1, E09-S03).
--
-- Crucible has two distinct populations and conflating them is a security defect:
--   * Staff (admin / organiser / reviewer / viewer) hold accounts and sign in.
--   * Teams do not. A team proves itself with a scoped, revocable submission token (P8.2),
--     because issuing fifty accounts for a one-evening event is all risk and no benefit.

CREATE TABLE IF NOT EXISTS crucible_user (
  user_id       BIGSERIAL    PRIMARY KEY,
  email         TEXT         NOT NULL UNIQUE,
  display_name  TEXT         NOT NULL,
  -- argon2/bcrypt digest. Never a plaintext or reversible value (P8.3).
  password_hash TEXT,
  role          TEXT         NOT NULL DEFAULT 'viewer'
                  CHECK (role IN ('admin', 'organiser', 'reviewer', 'viewer')),
  active        BOOLEAN      NOT NULL DEFAULT TRUE,
  -- P7.4 soft delete with a reason code.
  deleted_at    TIMESTAMPTZ,
  deleted_by    TEXT,
  delete_reason TEXT
                  CHECK (delete_reason IS NULL OR delete_reason IN
                    ('USER_REQUEST', 'ADMIN_ACTION', 'GDPR_ERASURE', 'CASCADE', 'DEDUP', 'SUPERSEDED')),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crucible_user_role ON crucible_user (role) WHERE deleted_at IS NULL;

-- Scoped, revocable credentials (P8.2). Revocation is immediate: lookups filter on revoked_at,
-- and nothing caches a token's validity.
CREATE TABLE IF NOT EXISTS access_token (
  token_id     BIGSERIAL    PRIMARY KEY,
  -- SHA-256 of the token. The token itself is shown once at issue and never stored (P8.3).
  token_hash   CHAR(64)     NOT NULL UNIQUE,
  kind         TEXT         NOT NULL
                 CHECK (kind IN ('SUBMISSION', 'SERVICE')),
  label        TEXT         NOT NULL,
  scopes       TEXT[]       NOT NULL DEFAULT '{}',
  issued_by    TEXT,
  issued_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_access_token_active
  ON access_token (token_hash) WHERE revoked_at IS NULL;

-- Published read model (P1.3): other modules resolve an actor's role through this view only,
-- never by selecting from crucible_user directly.
CREATE OR REPLACE VIEW v_governance_actor AS
SELECT user_id,
       email,
       display_name,
       role,
       active
FROM crucible_user
WHERE deleted_at IS NULL;
