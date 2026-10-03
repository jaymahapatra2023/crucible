-- 057 — `reviewer_model` is named for a pass that does not exist (E14-S04).
--
-- The column and the config key both read as though scores are reviewed by a second, stronger
-- model. They are not. The only use anywhere in the codebase is as the model the retry ladder
-- switches to after an empty response — a fallback, not a reviewer.
--
-- Anyone auditing this system, including a future maintainer, would read the schema and conclude
-- a control exists that does not. Renaming is the cheap honest fix.
--
-- What this does NOT do is add the missing pass. P4.3 requires Worker/Reviewer/Judge for every
-- CRITICAL artifact and names six call keys; only `rubrics.criteria_generate` has it, while
-- `scoring.criterion`, `scoring.engineering`, `scoring.principles` and `scoring.standards` have
-- no reviewer at all. That is a real violation of a stated principle, it triples the cost of the
-- dominant spend to close, and it is recorded as an open decision rather than settled silently
-- here. See docs/CRUCIBLE_REMEDIATION_EPICS.md.

ALTER TABLE llm_call_config RENAME COLUMN reviewer_model TO fallback_model;

COMMENT ON COLUMN llm_call_config.fallback_model IS
  'The model the retry ladder switches to when a response comes back empty (P4.2). This is a '
  'fallback, NOT a reviewer: no second-opinion or critic pass exists in this system.';

UPDATE app_config
   SET key = 'llm.fallback_model',
       description = 'The model the retry ladder switches to after an empty response. Not a '
         || 'reviewer: no second-opinion pass exists.'
 WHERE key = 'llm.reviewer_model';

-- The rename changes which key the pin carries, so a run opened before this migration holds
-- 'llm.reviewer_model' and would fail the pinned read. Outcome settings are declared, and this
-- one still is.
UPDATE app_config SET affects_outcome = TRUE WHERE key = 'llm.fallback_model';
