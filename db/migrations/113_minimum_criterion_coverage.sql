-- 113 — A composite built on too little of the rubric is not a score.
--
-- Measured on the event's own first full run: across fifteen entries, criterion coverage and
-- rank correlated at +0.61. The entry ranked FIRST had scored 39% of the rubric; the entry
-- ranked LAST had scored 91%. The order was being driven by how much evidence was missing.
--
-- That is not noise, it is bias with a direction. A dimension averages over the weight it
-- covered, so a criterion an entry would have failed raises its mark by being absent. Calibration
-- saw the same thing on one entry — a perfect 100 where counting its gap as zero gave 92 — and
-- this run showed it is the dominant signal once coverage varies widely across a cohort.
--
-- So: below this share of the rubric's weight, a submission carries COVERAGE_TOO_LOW and is to be
-- read as unranked pending review rather than as a score. It is NOT removed from the list —
-- hiding a team is worse than flagging one — and it is NOT scored zero, which would be the same
-- mistake in the other direction.
--
-- 0.7 chosen by the organiser. At 0 the check is disabled, which is how an operator turns it off
-- without a deploy.

INSERT INTO app_config (key, value, value_type, description, module, editable, affects_outcome)
VALUES (
  'scoring.min_criterion_coverage',
  '0.7'::jsonb,
  'number',
  'Share of the rubric''s weight that must have produced a score for a composite to be read as a '
    || 'score. Below it the submission is flagged COVERAGE_TOO_LOW and reported as unranked '
    || 'pending review — never removed from the list, never scored zero. Measured at codeLinc 11: '
    || 'coverage and rank correlated at +0.61, so a thin composite is biased UPWARD, not merely '
    || 'uncertain. 0 disables the check.',
  'scoring',
  TRUE,
  TRUE
)
ON CONFLICT (key) DO NOTHING;
