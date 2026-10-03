-- 023 — Principles and standards (E06-S03).
--
-- The committee chooses the list (OD-2). The nine cloud-architecture pillars are seeded as a
-- STARTING POINT only, marked inactive, so adopting them is a deliberate act rather than a
-- default nobody decided (finding F4's first invariant applies here too).

CREATE TABLE IF NOT EXISTS arch_principle (
  principle_id  BIGSERIAL    PRIMARY KEY,
  code          TEXT         NOT NULL UNIQUE,
  name          TEXT         NOT NULL,
  description   TEXT         NOT NULL,
  -- What a reader should be able to point at — the same bar E02-S05 applies to criteria.
  evidence_spec TEXT         NOT NULL,
  anchor_0      TEXT         NOT NULL,
  anchor_1      TEXT         NOT NULL,
  anchor_2      TEXT         NOT NULL,
  anchor_3      TEXT         NOT NULL,
  anchor_4      TEXT         NOT NULL,
  active        BOOLEAN      NOT NULL DEFAULT FALSE,
  sort_order    INTEGER      NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS it_standard (
  standard_id   BIGSERIAL    PRIMARY KEY,
  code          TEXT         NOT NULL UNIQUE,
  name          TEXT         NOT NULL,
  description   TEXT         NOT NULL,
  evidence_spec TEXT         NOT NULL,
  active        BOOLEAN      NOT NULL DEFAULT FALSE,
  sort_order    INTEGER      NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- A principle is a journey (0-4 maturity); a standard is a switch (met or not). The plan's
-- source material treats these as a deliberate two-axis distinction, and Crucible keeps it.
CREATE TABLE IF NOT EXISTS principle_assessment (
  id            BIGSERIAL    PRIMARY KEY,
  run_index_id  BIGINT       NOT NULL REFERENCES score_run (run_index_id) ON DELETE CASCADE,
  submission_id BIGINT       NOT NULL,
  principle_id  BIGINT       NOT NULL REFERENCES arch_principle (principle_id),
  maturity      INTEGER      CHECK (maturity IS NULL OR maturity BETWEEN 0 AND 4),
  non_score     TEXT         CHECK (non_score IS NULL OR non_score IN
                    ('INSUFFICIENT_EVIDENCE', 'SCORING_FAILED', 'NOT_APPLICABLE')),
  confidence    INTEGER      NOT NULL DEFAULT 0,
  rationale     TEXT         NOT NULL DEFAULT '',
  evidence      JSONB        NOT NULL DEFAULT '[]'::jsonb,
  assessed_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (run_index_id, submission_id, principle_id),
  CONSTRAINT chk_principle_xor CHECK (
    (maturity IS NOT NULL AND non_score IS NULL) OR (maturity IS NULL AND non_score IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS standard_assessment (
  id            BIGSERIAL    PRIMARY KEY,
  run_index_id  BIGINT       NOT NULL REFERENCES score_run (run_index_id) ON DELETE CASCADE,
  submission_id BIGINT       NOT NULL,
  standard_id   BIGINT       NOT NULL REFERENCES it_standard (standard_id),
  compliance    TEXT         CHECK (compliance IS NULL OR compliance IN
                    ('COMPLIANT', 'PARTIAL', 'NON_COMPLIANT', 'NOT_APPLICABLE')),
  non_score     TEXT         CHECK (non_score IS NULL OR non_score IN
                    ('INSUFFICIENT_EVIDENCE', 'SCORING_FAILED', 'NOT_APPLICABLE')),
  confidence    INTEGER      NOT NULL DEFAULT 0,
  rationale     TEXT         NOT NULL DEFAULT '',
  evidence      JSONB        NOT NULL DEFAULT '[]'::jsonb,
  assessed_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (run_index_id, submission_id, standard_id),
  CONSTRAINT chk_standard_xor CHECK (
    (compliance IS NOT NULL AND non_score IS NULL) OR (compliance IS NULL AND non_score IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_principle_assessment_sub
  ON principle_assessment (submission_id, run_index_id);
CREATE INDEX IF NOT EXISTS idx_standard_assessment_sub
  ON standard_assessment (submission_id, run_index_id);
