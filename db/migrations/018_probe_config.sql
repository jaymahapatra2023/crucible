-- 018 — Sandbox policy as configuration (P3.6). Every limit is tunable without a redeploy,
-- because the E11-S04 dry run is expected to replace these guesses with measurements.

INSERT INTO app_config (key, value, value_type, description, module, editable) VALUES
('probes.timeout_ms', '300000'::jsonb, 'number',
 'Hard wall-clock limit for one probe, build and settle included (E05-S01 acceptance 4).',
 'probes', TRUE),
('probes.settle_seconds', '10'::jsonb, 'number',
 'How long a started container must stay up to count as running (E05-S02 acceptance 2).',
 'probes', TRUE),
('probes.memory_mb', '2048'::jsonb, 'number',
 'Memory ceiling. Swap is pinned to the same value so the limit is real rather than a slowdown.',
 'probes', TRUE),
('probes.cpus', '2'::jsonb, 'number', 'CPU ceiling for one probe.', 'probes', TRUE),
('probes.pids_limit', '256'::jsonb, 'number',
 'Process ceiling. This is the control that stops a fork bomb.', 'probes', TRUE),
('probes.log_cap_bytes', '262144'::jsonb, 'number',
 'Bytes of build log retained. Beyond this the middle is dropped and the truncation is stated.',
 'probes', TRUE),
('probes.egress_allow_list', '[]'::jsonb, 'json',
 'Hosts a build may reach. EMPTY MEANS NO NETWORK, which is the default and the safe value. Adding a host here is a deliberate decision and is recorded on every probe it affects (E05-S01 acceptance 3).',
 'probes', TRUE)
ON CONFLICT (key) DO NOTHING;

INSERT INTO feature_flag (key, enabled, description) VALUES
('feature.probes.enabled', TRUE,
 'Run build probes. Disabling records UNSUPPORTED for the Runs dimension rather than zero, so no team is scored down for a capability we turned off.')
ON CONFLICT (key) DO NOTHING;
