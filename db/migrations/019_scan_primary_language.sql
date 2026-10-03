-- 019 — Record the dominant language of a scanned repository.
--
-- The prober needs a language to pick a base image on the COMMAND path. It was deriving one by
-- taking the first entry of the scan's alphabetically-sorted language list, which is arbitrary:
-- for a TypeScript project with a shell script, "javascript" or "shell" could win on ordering
-- alone and the submission would be built in the wrong image.
--
-- The scanner already computes the dominant language by file count; it is now persisted.
--
-- The views are DROPped and recreated rather than replaced: CREATE OR REPLACE VIEW cannot add a
-- column in the middle of the select list, and `v_scans_coverage` depends on `v_scans_latest`.

ALTER TABLE scan ADD COLUMN IF NOT EXISTS primary_language TEXT;

DROP VIEW IF EXISTS v_scans_coverage;
DROP VIEW IF EXISTS v_scans_latest;

CREATE VIEW v_scans_latest AS
SELECT DISTINCT ON (submission_id)
       scan_id, submission_id, commit_sha, depth,
       files_analyzed, files_total, budget_truncated,
       total_lines, code_lines, comment_lines, languages, primary_language,
       has_tests, test_file_count, has_ci, has_dockerfile, has_readme, dependency_count,
       content_hash, finished_at
FROM scan
WHERE status = 'COMPLETED' AND superseded_at IS NULL
ORDER BY submission_id, finished_at DESC;

CREATE VIEW v_scans_coverage AS
SELECT submission_id,
       files_analyzed,
       files_total,
       budget_truncated,
       CASE WHEN files_total = 0 THEN 0
            ELSE round((files_analyzed::numeric / files_total) * 100, 1) END AS coverage_pct
FROM v_scans_latest;
