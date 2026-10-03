-- 015 — Scanner configuration (E04-S04 acceptance 1, E04-S06 acceptance 3). Data, not constants.

INSERT INTO app_config (key, value, value_type, description, module, editable) VALUES

('scans.default_depth', '"standard"'::jsonb, 'string',
 'Depth profile used when a run does not specify one. The E11-S04 dry run replaces this default with a measured one.',
 'scans', TRUE),

('scans.clone_timeout_ms', '300000'::jsonb, 'number',
 'Wall-clock limit for cloning a submission before scanning it.',
 'scans', TRUE),

('scans.history_depth', '"full"'::jsonb, 'string',
 'Clone history depth. Provenance (E04-S06) needs real history, so this is "full" and the cost is accepted knowingly (acceptance 4). Set to a number to trade provenance accuracy for clone time.',
 'scans', TRUE),

-- E04-S06 acceptance 3: thresholds are configuration, and they only ever raise a flag.
('scans.provenance_max_out_of_window_pct', '40'::jsonb, 'number',
 'Share of commits outside the event window above which a submission is FLAGGED for human review. Never an automatic exclusion.',
 'scans', TRUE),

('scans.provenance_max_single_commit_pct', '80'::jsonb, 'number',
 'Share of all added lines in one commit above which a submission is FLAGGED. An initial import and a legitimate first commit look identical, so a person decides.',
 'scans', TRUE),

('scans.event_window', 'null'::jsonb, 'json',
 'Event window for provenance classification as {"startsAt":"...","endsAt":"..."} (OD-4). Null disables in/out-of-window counting rather than guessing a window.',
 'scans', TRUE)

ON CONFLICT (key) DO NOTHING;

INSERT INTO feature_flag (key, enabled, description) VALUES
('feature.scans.provenance', TRUE,
 'Analyse git history for provenance. Disabling skips it and records no provenance, rather than recording zeroes.')
ON CONFLICT (key) DO NOTHING;
