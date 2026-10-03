-- 005 — LLM gateway registry, config, prompts and audit (P3.1–P3.6, E01-S04).
--
-- Every model call is registered, configured, prompted and audited from these tables. A call
-- site that cannot name a registered call_key cannot run — that is the mechanism by which
-- P3.1/P3.2 are enforced at runtime rather than by code review alone.

CREATE TABLE IF NOT EXISTS llm_call_registry (
  call_key            TEXT        PRIMARY KEY
                        CHECK (call_key ~ '^[a-z0-9_]+(\.[a-z0-9_]+)+$'),
  module              TEXT        NOT NULL,
  purpose             TEXT        NOT NULL,
  criticality         TEXT        NOT NULL DEFAULT 'STANDARD'
                        CHECK (criticality IN ('CRITICAL', 'STANDARD', 'BEST_EFFORT')),
  input_variables     TEXT[]      NOT NULL DEFAULT '{}',
  has_fallback        BOOLEAN     NOT NULL DEFAULT FALSE,
  -- P3.5 exception: a score has no honest fallback. Where this is TRUE, failure is reported as
  -- SCORING_FAILED rather than substituted with a synthesised value.
  failure_is_terminal BOOLEAN     NOT NULL DEFAULT FALSE,
  -- P4.3: CRITICAL keys must run worker → reviewer → judge.
  requires_review     BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_fallback_xor_terminal
    CHECK (NOT (has_fallback AND failure_is_terminal))
);

CREATE TABLE IF NOT EXISTS llm_call_config (
  call_key        TEXT        PRIMARY KEY REFERENCES llm_call_registry (call_key) ON DELETE CASCADE,
  model           TEXT        NOT NULL,
  reviewer_model  TEXT,
  max_tokens      INTEGER     NOT NULL DEFAULT 4096 CHECK (max_tokens > 0),
  -- P4.4: scoring calls are temperature 0 by default; determinism is the point.
  temperature     NUMERIC(3,2) NOT NULL DEFAULT 0 CHECK (temperature >= 0 AND temperature <= 2),
  timeout_ms      INTEGER     NOT NULL DEFAULT 120000 CHECK (timeout_ms > 0),
  max_attempts    INTEGER     NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 6),
  -- P3.4: full prompt/response text is stored only when explicitly enabled, per call key.
  log_prompts     BOOLEAN     NOT NULL DEFAULT FALSE,
  log_responses   BOOLEAN     NOT NULL DEFAULT FALSE,
  enabled         BOOLEAN     NOT NULL DEFAULT TRUE,
  updated_by      TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- P3.3 — prompts are data, versioned, tunable without a redeploy.
CREATE TABLE IF NOT EXISTS llm_prompt_template (
  template_id   BIGSERIAL   PRIMARY KEY,
  call_key      TEXT        NOT NULL REFERENCES llm_call_registry (call_key) ON DELETE CASCADE,
  version       INTEGER     NOT NULL,
  role          TEXT        NOT NULL DEFAULT 'user' CHECK (role IN ('system', 'user')),
  body          TEXT        NOT NULL,
  content_hash  CHAR(64)    NOT NULL,
  active        BOOLEAN     NOT NULL DEFAULT TRUE,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (call_key, role, version)
);

-- Exactly one active template per (call_key, role).
CREATE UNIQUE INDEX IF NOT EXISTS uq_prompt_active
  ON llm_prompt_template (call_key, role) WHERE active;

CREATE TABLE IF NOT EXISTS llm_fallback_rule (
  call_key     TEXT        PRIMARY KEY REFERENCES llm_call_registry (call_key) ON DELETE CASCADE,
  strategy     TEXT        NOT NULL
                 CHECK (strategy IN ('RULE_BASED', 'PASSTHROUGH', 'TEMPLATE_RETURN', 'SHA256_DEDUP', 'FIELD_FORMULA')),
  config       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- P3.4 — every call produces a row here. Append-only; writes are fire-and-forget.
CREATE TABLE IF NOT EXISTS llm_call_log (
  log_id            BIGSERIAL    PRIMARY KEY,
  call_key          TEXT         NOT NULL,
  correlation_id    TEXT,
  run_id            BIGINT,
  model_used        TEXT         NOT NULL,
  status            TEXT         NOT NULL
                      CHECK (status IN ('OK', 'SCHEMA_INVALID', 'PARSE_FAILED', 'TIMEOUT',
                                        'RATE_LIMITED', 'PROVIDER_ERROR', 'DISABLED', 'FALLBACK')),
  attempt           INTEGER      NOT NULL DEFAULT 1,
  latency_ms        INTEGER      NOT NULL,
  tokens_in         INTEGER      NOT NULL DEFAULT 0,
  tokens_out        INTEGER      NOT NULL DEFAULT 0,
  cost_usd          NUMERIC(12,6) NOT NULL DEFAULT 0,
  prompt_hash       CHAR(64)     NOT NULL,
  -- Stored only when llm_call_config.log_prompts / log_responses is TRUE. Submission source
  -- code is never written here regardless of the flag (P3.4).
  prompt_text       TEXT,
  response_text     TEXT,
  fallback_triggered BOOLEAN     NOT NULL DEFAULT FALSE,
  error             TEXT,
  at                TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_llm_log_key  ON llm_call_log (call_key, at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_log_run  ON llm_call_log (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_llm_log_corr ON llm_call_log (correlation_id);

-- Published read model for cost accounting (E10-S03) — the batch module reads this, never
-- llm_call_log directly (P1.3).
CREATE OR REPLACE VIEW v_llm_run_cost AS
SELECT run_id,
       COUNT(*)            AS calls,
       SUM(tokens_in)      AS tokens_in,
       SUM(tokens_out)     AS tokens_out,
       SUM(cost_usd)       AS cost_usd,
       COUNT(*) FILTER (WHERE status <> 'OK') AS failed_calls
FROM llm_call_log
WHERE run_id IS NOT NULL
GROUP BY run_id;
