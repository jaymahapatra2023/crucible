-- 035 — Every automated caveat, in one place (E08-S03).
--
-- The story asks for "every automated caveat surfaced, so that nothing silently shapes the
-- outcome". Those caveats are currently scattered across six tables: a truncated scan, an
-- unscoreable criterion, an unsupported stack, a provenance observation, a cohort too small to
-- normalise, a disagreement between the two runs. A reviewer cannot be expected to visit six
-- screens and infer the union.
--
-- Materialised at ranking time rather than computed on read, and for the same reason as the
-- ranking itself: this is the set of caveats the reviewer was shown when they decided. A list
-- re-derived later, after a re-scan or a configuration change, is a different list, and the
-- record would not say which one informed the decision.

CREATE TABLE IF NOT EXISTS review_flag (
  id             BIGSERIAL    PRIMARY KEY,
  run_index_id   BIGINT       NOT NULL REFERENCES score_run (run_index_id) ON DELETE CASCADE,
  submission_id  BIGINT       NOT NULL,

  code           TEXT         NOT NULL,
  -- ADVISORY informs; ATTENTION asks for a look. Neither blocks, and nothing here excludes.
  severity       TEXT         NOT NULL CHECK (severity IN ('ADVISORY', 'ATTENTION')),
  -- Plain language, not a code (acceptance 2). Written at generation time so the wording a
  -- reviewer saw is the wording that is kept.
  message        TEXT         NOT NULL CHECK (length(trim(message)) > 0),
  -- The figures behind it, so the message can be checked rather than trusted.
  detail         JSONB        NOT NULL DEFAULT '{}'::jsonb,

  dismissed_at     TIMESTAMPTZ,
  dismissed_by     TEXT,
  dismissal_reason TEXT,

  raised_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (run_index_id, submission_id, code),

  -- Acceptance 3, at the level that cannot be worked around by the next caller.
  CONSTRAINT chk_flag_dismissal_has_reason CHECK (
    (dismissed_at IS NULL AND dismissed_by IS NULL AND dismissal_reason IS NULL)
    OR (dismissed_at IS NOT NULL AND dismissed_by IS NOT NULL
        AND dismissal_reason IS NOT NULL AND length(trim(dismissal_reason)) >= 10)
  )
);

CREATE INDEX IF NOT EXISTS idx_review_flag_open
  ON review_flag (run_index_id, submission_id) WHERE dismissed_at IS NULL;

-- Published read model (P1.3).
CREATE OR REPLACE VIEW v_review_flags AS
SELECT rf.run_index_id,
       rf.submission_id,
       rf.code,
       rf.severity,
       rf.message,
       rf.detail,
       (rf.dismissed_at IS NOT NULL) AS dismissed,
       rf.dismissed_by,
       rf.dismissal_reason,
       rf.dismissed_at,
       rf.raised_at
FROM review_flag rf;
