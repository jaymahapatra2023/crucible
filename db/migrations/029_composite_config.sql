-- 029 — Configuration the composite pass reads (E06-S06, E07-S02, E07-S03).
--
-- Each of these is a policy decision rather than a constant, which is why it is here and not in
-- the code: a committee that wants to weight its adopted principles differently, or that runs a
-- forty-team event where a fifteen-team cohort floor is the wrong call, changes a row.

INSERT INTO app_config (key, value, value_type, description, module, editable) VALUES

('scoring.principles_rubric_split', '0.5'::jsonb, 'number',
 'Share of the principles-and-standards dimension carried by the committee''s own rubric criteria when BOTH rubric criteria and adopted principles exist. 0.5 gives each half; 1 ignores the adopted list; 0 ignores the rubric criteria. Has no effect when only one source is present — the other then takes the whole dimension.',
 'scoring', TRUE),

('scoring.min_cohort_size', '15'::jsonb, 'number',
 'Fewest submissions in a challenge before challenge-fidelity is normalised within that cohort (E07-S03). Below this the raw score is used unchanged and the submission is flagged for human review, because a percentile over six teams says more about who else entered than about the work.',
 'scoring', TRUE),

('scoring.cut_line', '25'::jsonb, 'number',
 'Rank at which the shortlist is drawn, for variance and cut-band reporting. Crucible NEVER acts on this: it decides which submissions are reported as borderline, not which are selected (P0 constraint 1, E07-S04 acceptance 3).',
 'scoring', TRUE),

('scoring.cut_band_size', '3'::jsonb, 'number',
 'How many ranks either side of the cut line are reported as the borderline band (E07-S06).',
 'scoring', TRUE)

ON CONFLICT (key) DO NOTHING;
