-- 089 — Configuration descriptions that the E50 review made stale.
--
-- The substantive-code floor no longer refuses a submission; it is a pre-flight finding the team
-- is told about. A description that still says "refused" would send an organiser looking for a
-- refusal that no longer happens.

UPDATE app_config
   SET description = 'Fewest lines of code, outside generated and configuration files, for an entry to count as having substantive work. Below this the pre-flight reports a problem naming the count (E50); nothing is refused.'
 WHERE key = 'submissions.tier1_min_code_lines';
