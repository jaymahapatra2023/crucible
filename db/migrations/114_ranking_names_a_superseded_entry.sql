-- 114 — A ranking row keeps its team name after the team resubmits.
--
-- `v_scoring_ranking` resolved the submission through `v_submissions_submission`, which filters
-- `WHERE s.is_current`. So the moment a team submitted again, every ranking row for the version
-- that HAD been scored lost its team name, challenge and repository — the row stayed, the
-- identity went NULL.
--
-- Found at the event: a team reached version 5 while a run was being ranked, and their row in
-- the ranking came back anonymous. An exported CSV would have carried a blank team name next to
-- a composite, which is worse than an error — it looks like data.
--
-- A ranking row is about ONE submission, named by its id. Whether that submission is still the
-- team's current one is a different question, and the answer must not erase who it belonged to.
-- So the join goes to `submission` directly.
--
-- DROP then CREATE inside a transaction. A previous view rebuild here was run without one, the
-- DROP committed, the CREATE failed on a stale name, and a live system was left without the view.

DROP VIEW v_scoring_ranking;

CREATE VIEW v_scoring_ranking AS
SELECT sc.run_index_id,
    sr.cohort_key,
    sc.submission_id,
    sc.challenge_id,
    sub.team_name,
    sc.composite,
    sc.fidelity_raw,
    sc.fidelity_normalised,
    sc.cohort_size,
    sc.normalisation_method,
    sc.rank_global,
    sc.rank_in_challenge,
    sc.tied,
    sc.weight_covered,
    sc.criterion_coverage,
    sc.missing_dimensions,
    sc.partial,
    sc.in_cut_band,
    sc.advisory_decided,
    sc.requires_review,
    sc.review_reasons,
    sc.computed_at
   FROM submission_composite sc
     JOIN score_run sr ON sr.run_index_id = sc.run_index_id
     LEFT JOIN submission sub ON sub.submission_id = sc.submission_id;
