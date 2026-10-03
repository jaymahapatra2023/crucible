-- 074 — The supporting links teams attach are read (E36).
--
-- `submission.artifact_urls` has existed since E03 and holds up to five links per team. Nothing
-- has ever read it: not the scanner, not discovery, not scoring, and not the review page. A team
-- that attached an architecture document had it recorded and ignored, which is the defect this
-- codebase keeps finding in new places.
--
-- It matters now because two judging criteria — "does the presentation touch upon the application
-- architecture" and "does the demo clearly depict the functionality" — have no evidence anywhere
-- else in a repository.
--
-- FETCHING IS THE DANGEROUS PART. A URL supplied by an entrant, fetched by a server inside the
-- evaluation network, is server-side request forgery with extra steps. The defences are the same
-- ones `checkUrl` already applies to repositories, and for the same reason: an allow-list of
-- hosts is the only one that fails closed.

CREATE TABLE IF NOT EXISTS submission_artifact (
  artifact_id   BIGSERIAL    PRIMARY KEY,
  submission_id BIGINT       NOT NULL REFERENCES submission (submission_id) ON DELETE CASCADE,
  url           TEXT         NOT NULL,

  -- REFUSED means Crucible declined to fetch it — a host not on the list, a scheme that is not
  -- https. That is a different fact from UNREACHABLE, where the fetch was attempted and failed,
  -- and an organiser widening the allow-list needs to tell them apart.
  status        TEXT         NOT NULL
                  CHECK (status IN ('FETCHED', 'REFUSED', 'UNREACHABLE', 'TOO_LARGE',
                                    'UNSUPPORTED_TYPE', 'EMPTY')),
  content_type  TEXT,
  bytes         INTEGER      NOT NULL DEFAULT 0,

  -- Extracted text, capped. NULL unless FETCHED. This is untrusted, entrant-supplied content and
  -- every path that shows it to a model must fence it as such (P8.4) — it is the most directly
  -- attacker-controlled text in the system, because a team chooses both the words and the file.
  text_content  TEXT,

  detail        TEXT         NOT NULL DEFAULT '',
  fetched_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  fetched_by    TEXT         NOT NULL,

  CONSTRAINT chk_artifact_text CHECK (
    (status = 'FETCHED' AND text_content IS NOT NULL) OR
    (status <> 'FETCHED' AND text_content IS NULL)
  )
);

-- One record per (submission, url). Re-fetching replaces it: the current state of a link is the
-- fact of interest, and a history of attempts would outgrow what anybody reads.
CREATE UNIQUE INDEX IF NOT EXISTS uq_submission_artifact
  ON submission_artifact (submission_id, url);

/*
 * Published for the modules that identify a submission to a reader (P1.3). Review shows these
 * beside the repository; scoring may feed them to a model as untrusted context.
 */
CREATE OR REPLACE VIEW v_submission_artifact AS
SELECT artifact_id, submission_id, url, status, content_type, bytes, text_content, detail,
       fetched_at
FROM submission_artifact;

INSERT INTO app_config (key, value, value_type, description, module, editable, affects_outcome)
VALUES
  ('submissions.artifact_hosts',
   '["github.com", "gitlab.com", "raw.githubusercontent.com", "gist.githubusercontent.com"]'::jsonb,
   'json',
   'Hosts a supporting link may be fetched from (E36). Deliberately narrow: an allow-list is the only SSRF defence that fails closed, and a refusal names the host so an organiser knows what to add.',
   'submissions', TRUE, FALSE),

  ('submissions.artifact_max_bytes', '2097152'::jsonb, 'number',
   'Largest supporting document Crucible will fetch, in bytes (E36).',
   'submissions', TRUE, FALSE),

  ('submissions.artifact_max_chars', '40000'::jsonb, 'number',
   'Most extracted characters kept per supporting document (E36). Beyond this a document is stored truncated, and says so.',
   'submissions', TRUE, FALSE)
ON CONFLICT (key) DO NOTHING;

COMMENT ON TABLE submission_artifact IS
  'Fetched supporting documents for a submission (E36). text_content is untrusted entrant input.';
