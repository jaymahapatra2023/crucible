-- 037 — The publication record (E09-S04).
--
-- The rubric row already carries `published_at`, and the frozen-rubric trigger already makes its
-- criteria immutable. What was missing is the DOCUMENT: the export teams actually received was
-- re-rendered from the rubric on every request, so a change to the renderer — a formatting fix,
-- an added column, a reworded heading — would silently change what "what teams received" means,
-- with nothing recording that it had changed.
--
-- "Export reproduces exactly what teams received" (acceptance 2) therefore requires storing the
-- rendered bytes, not the ability to re-render them. This table is that snapshot, append-only by
-- trigger: publishing again adds a row rather than replacing one, because a rubric republished
-- after a correction has two publication events and a team may have seen either.

CREATE TABLE IF NOT EXISTS rubric_publication (
  publication_id BIGSERIAL    PRIMARY KEY,
  rubric_id      BIGINT       NOT NULL REFERENCES rubric (rubric_id),
  challenge_id   BIGINT       NOT NULL,
  slug           TEXT         NOT NULL,
  version        INTEGER      NOT NULL,

  -- The rubric's own content hash: what was judged against.
  content_hash   CHAR(64)     NOT NULL,

  -- The rendered documents, byte for byte, and a hash over them: what was READ.
  document_markdown TEXT      NOT NULL,
  document_html     TEXT      NOT NULL,
  document_hash     CHAR(64)  NOT NULL,

  published_by   TEXT         NOT NULL,
  published_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rubric_publication_slug
  ON rubric_publication (slug, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_rubric_publication_rubric
  ON rubric_publication (rubric_id, published_at DESC);

/*
 * Append-only, enforced the same way the audit log is (P7.1).
 *
 * A publication record that can be edited answers "we were not told" with a document that may
 * have been written afterwards, which is worse than having no record: it looks authoritative.
 */
CREATE OR REPLACE FUNCTION refuse_publication_change() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'rubric_publication is append-only (E09-S04): publication records cannot be % ',
    lower(TG_OP);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_publication_append_only ON rubric_publication;
CREATE TRIGGER trg_publication_append_only
  BEFORE UPDATE OR DELETE ON rubric_publication
  FOR EACH ROW EXECUTE FUNCTION refuse_publication_change();

-- Published read model (P1.3): the current publication for each slug.
CREATE OR REPLACE VIEW v_rubric_publications AS
SELECT DISTINCT ON (slug)
       publication_id, rubric_id, challenge_id, slug, version,
       content_hash, document_hash, published_by, published_at
FROM rubric_publication
ORDER BY slug, published_at DESC;
