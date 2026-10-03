-- 007 — Challenges and their brief artifacts (E02-S01, E02-S02).
--
-- Uploaded files are retained and re-downloadable: the rubric must remain traceable to its
-- source after the event (E02-S01 acceptance 3). Extracted text is persisted so generation is
-- repeatable without re-parsing (E02-S02 acceptance 3).

CREATE TABLE IF NOT EXISTS challenge (
  challenge_id  BIGSERIAL    PRIMARY KEY,
  name          TEXT         NOT NULL,
  slug          TEXT         NOT NULL UNIQUE
                  CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
  description   TEXT         NOT NULL DEFAULT '',
  status        TEXT         NOT NULL DEFAULT 'DRAFT'
                  CHECK (status IN ('DRAFT', 'OPEN', 'CLOSED')),
  created_by    TEXT,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- P7.4 soft delete. A challenge may only be soft-deleted while DRAFT (E02-S01 acceptance 4);
  -- the service enforces that, since the condition spans a state check and a write.
  deleted_at    TIMESTAMPTZ,
  deleted_by    TEXT,
  delete_reason TEXT
                  CHECK (delete_reason IS NULL OR delete_reason IN
                    ('USER_REQUEST', 'ADMIN_ACTION', 'GDPR_ERASURE', 'CASCADE', 'DEDUP', 'SUPERSEDED'))
);

CREATE INDEX IF NOT EXISTS idx_challenge_live ON challenge (status) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS challenge_artifact (
  artifact_id      BIGSERIAL    PRIMARY KEY,
  challenge_id     BIGINT       NOT NULL REFERENCES challenge (challenge_id) ON DELETE CASCADE,
  kind             TEXT         NOT NULL
                     CHECK (kind IN ('BRIEF', 'SUPPORTING', 'RULES', 'DATA_SAMPLE')),
  filename         TEXT         NOT NULL,
  media_type       TEXT         NOT NULL,
  bytes            BIGINT       NOT NULL CHECK (bytes >= 0),
  -- Where the original file is retained, so it stays re-downloadable after the event.
  storage_uri      TEXT         NOT NULL,
  content_hash     CHAR(64)     NOT NULL,

  -- Extraction outcome (E02-S02). A failure is recorded per file and does NOT fail the batch
  -- (acceptance 2), so a partially-extracted challenge is visible rather than silently thin.
  extraction_status TEXT        NOT NULL DEFAULT 'PENDING'
                      CHECK (extraction_status IN ('PENDING', 'EXTRACTED', 'FAILED', 'UNSUPPORTED')),
  extraction_error  TEXT,
  extracted_text    TEXT,
  -- Section or page markers retained, so source_ref can name a location (acceptance 1).
  extracted_sections JSONB      NOT NULL DEFAULT '[]'::jsonb,
  extracted_at      TIMESTAMPTZ,

  uploaded_by      TEXT,
  uploaded_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_artifact_challenge ON challenge_artifact (challenge_id, kind);
CREATE INDEX IF NOT EXISTS idx_artifact_extraction
  ON challenge_artifact (extraction_status) WHERE extraction_status <> 'EXTRACTED';

-- Published read model (P1.3): other modules read challenge identity through this view only.
CREATE OR REPLACE VIEW v_challenges_challenge AS
SELECT challenge_id,
       name,
       slug,
       status,
       created_at
FROM challenge
WHERE deleted_at IS NULL;

-- Extraction coverage, so E02-S04 can refuse to generate from a challenge whose brief did not
-- parse rather than quietly generating from nothing.
CREATE OR REPLACE VIEW v_challenges_extraction_health AS
SELECT c.challenge_id,
       COUNT(a.artifact_id)                                              AS artifacts,
       COUNT(*) FILTER (WHERE a.extraction_status = 'EXTRACTED')         AS extracted,
       COUNT(*) FILTER (WHERE a.extraction_status = 'FAILED')            AS failed,
       COUNT(*) FILTER (WHERE a.extraction_status = 'UNSUPPORTED')       AS unsupported,
       COALESCE(SUM(length(a.extracted_text)), 0)                        AS extracted_chars
FROM challenge c
LEFT JOIN challenge_artifact a ON a.challenge_id = c.challenge_id
WHERE c.deleted_at IS NULL
GROUP BY c.challenge_id;
