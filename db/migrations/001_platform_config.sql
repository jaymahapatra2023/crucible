-- 001 — Platform runtime configuration and feature flags.
--
-- P7.5: the database is the single source of truth for configuration. Environment variables are
-- bootstrap-only. Everything that governs behaviour at runtime — model name, concurrency limit,
-- cost ceiling, scan depth, every threshold — lives here and survives a restart.
--
-- P3.6: hardcoded behavioural constants are a CI failure, so this table is load-bearing rather
-- than a convenience.
--
-- Note on enums: Crucible uses TEXT + CHECK rather than native PG enum types throughout, because
-- adding a value to a CHECK constraint is an idempotent, guarded ALTER (E01-S02 acceptance 3)
-- while ALTER TYPE ... ADD VALUE cannot run inside a transaction.

CREATE TABLE IF NOT EXISTS app_config (
  key          TEXT         PRIMARY KEY,
  value        JSONB        NOT NULL,
  value_type   TEXT         NOT NULL
                 CHECK (value_type IN ('string', 'number', 'boolean', 'json')),
  description  TEXT         NOT NULL,
  -- Which module owns this key. Config is owned like tables are (P1.3).
  module       TEXT         NOT NULL,
  -- Operator-editable keys appear in the admin UI; internal ones do not.
  editable     BOOLEAN      NOT NULL DEFAULT TRUE,
  updated_by   TEXT,
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_app_config_module ON app_config (module);

-- Config history is append-only: a value that shaped a scoring run must remain reconstructible
-- months later (P7.1, P0 "explainable six months from now").
CREATE TABLE IF NOT EXISTS app_config_history (
  id           BIGSERIAL    PRIMARY KEY,
  key          TEXT         NOT NULL,
  old_value    JSONB,
  new_value    JSONB        NOT NULL,
  changed_by   TEXT,
  changed_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_app_config_history_key ON app_config_history (key, changed_at DESC);

CREATE OR REPLACE FUNCTION app_config_record_history() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO app_config_history (key, old_value, new_value, changed_by)
  VALUES (NEW.key,
          CASE WHEN TG_OP = 'UPDATE' THEN OLD.value ELSE NULL END,
          NEW.value,
          NEW.updated_by);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_app_config_history ON app_config;
CREATE TRIGGER trg_app_config_history
  AFTER INSERT OR UPDATE OF value ON app_config
  FOR EACH ROW EXECUTE FUNCTION app_config_record_history();

-- P12.3 — every major capability deploys behind a flag.
CREATE TABLE IF NOT EXISTS feature_flag (
  key          TEXT         PRIMARY KEY
                 CHECK (key ~ '^feature\.[a-z0-9_]+\.[a-z0-9_]+$'),
  enabled      BOOLEAN      NOT NULL DEFAULT FALSE,
  description  TEXT         NOT NULL,
  updated_by   TEXT,
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
