-- 062 — Working through flagged provenance (E19-S03, G17).
--
-- `GET /scans/provenance/flagged` has existed since E04-S06 and returns exactly what an operator
-- needs: the submissions whose commit history warrants a human look. Nothing in the application
-- called it, so the flags surfaced only inside one team's page — visible one at a time, with no
-- way to work through them as a list and no way to record that one had been looked at.
--
-- The framing that E04-S06 insists on is unchanged and is the reason this table exists at all:
-- these are FLAGS, never exclusions. Resolving one records what a person concluded. It does not
-- remove a submission, and there is deliberately no way here to do so.

CREATE TABLE IF NOT EXISTS provenance_resolution (
  resolution_id  BIGSERIAL    PRIMARY KEY,
  submission_id  BIGINT       NOT NULL,

  -- Mandatory, at the level the next caller cannot work around — the pattern `review_flag` and
  -- `discovery_dismissal` both use. "Looked at it" is not a conclusion.
  reason         TEXT         NOT NULL CHECK (length(trim(reason)) >= 10),
  resolved_by    TEXT         NOT NULL,
  resolved_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),

  withdrawn_at   TIMESTAMPTZ,
  withdrawn_by   TEXT
);

-- One standing resolution per submission; a second would make "has this been looked at?"
-- ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS uq_provenance_resolution_current
  ON provenance_resolution (submission_id) WHERE withdrawn_at IS NULL;

/*
 * The queue, as an operator works it.
 *
 * Resolved entries stay in the view rather than vanishing: a reader must be able to tell "a
 * person looked and was satisfied" from "nobody has looked yet", which is the same distinction
 * the discovery tiles and the score non-scores exist to protect.
 */
CREATE OR REPLACE VIEW v_provenance_queue AS
SELECT p.submission_id,
       p.scan_id,
       p.total_commits,
       p.commits_out_of_window,
       p.distinct_authors,
       p.largest_single_commit_pct,
       p.history_truncated,
       p.flags,
       p.analysed_at,
       r.resolution_id IS NOT NULL AS resolved,
       r.reason      AS resolution_reason,
       r.resolved_by AS resolved_by,
       r.resolved_at AS resolved_at
FROM provenance p
LEFT JOIN provenance_resolution r
       ON r.submission_id = p.submission_id AND r.withdrawn_at IS NULL
WHERE jsonb_array_length(p.flags) > 0;
