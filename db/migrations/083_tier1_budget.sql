-- 083 — A hard budget for the checks that block a submission (E45-S02 acceptance 5).
--
-- Tier 1 runs inside the submit request and refuses in seconds; anything that cannot answer in
-- seconds belongs to tier 2. The budget is what keeps that true when a repository is enormous or
-- a host is slow: exceeding it records PENDING with a reason, never a refusal — a team is not
-- turned away for being slow to clone.
--
-- Separate from `submissions.clone_timeout_ms`, which bounds one step. This bounds the whole
-- tier, so a fast clone followed by a slow walk still stops.

INSERT INTO app_config (key, value, value_type, description, module, editable, affects_outcome)
VALUES
  ('submissions.tier1_budget_ms', '25000'::jsonb, 'number',
   'Wall-clock budget for every synchronous submission check together (E45). Exceeding it records PENDING with a reason, never a refusal.',
   'submissions', TRUE, FALSE),
  ('submissions.tier1_min_code_lines', '50'::jsonb, 'number',
   'Fewest lines of code, outside generated and configuration files, for a repository to count as having substantive work (E45). Below this, submission is refused naming the count.',
   'submissions', TRUE, FALSE)
ON CONFLICT (key) DO NOTHING;
