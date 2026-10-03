-- 032 — Configuration for ranking and split reporting (E07-S04, E07-S05, E07-S06).

INSERT INTO app_config (key, value, value_type, description, module, editable) VALUES

('scoring.shortlist_size', '25'::jsonb, 'number',
 'How many submissions the review list holds (E07-S04 acceptance 3). Deliberately larger than the number that will present: Crucible produces a list for people to review, and never marks any of it as selected.',
 'scoring', TRUE),

('scoring.challenge_imbalance_pct', '70'::jsonb, 'number',
 'Share of the shortlist held by a single challenge above which a NON-BLOCKING advisory is raised (E07-S05 acceptance 2). It is an advisory because a lopsided split can be the honest result — one challenge may simply have attracted better work.',
 'scoring', TRUE)

ON CONFLICT (key) DO NOTHING;
