-- 112 — A probe may record that the SANDBOX stopped the application, graded one point below RUNS.
--
-- The event's first entry declared `npm install && npm run dev`. It cannot work: the run
-- container has no network, so npm cannot reach the registry. A second entry's Dockerfile does
-- `mkdir -p /data`, which cannot work either: the container runs as an unprivileged user and
-- /data is root-owned. Both were graded as failures, which says something untrue about the work.
--
-- Neither team wrote a broken application. They wrote applications that assume a normal machine,
-- which is what every tutorial, framework and deployment guide assumes. The sandbox is ours and
-- it is strict for good reasons (P8.5), but a score has to distinguish "this does not work" from
-- "we would not let it work".
--
-- So: a container that dies carrying a containment signature grades BLOCKED_BY_SANDBOX, worth 3
-- of 4 — 75 of 100 after the documented linear transform. One point, not none. The environment
-- is published and a build that does not start in it is still the team's to own; it is a
-- deduction, not an exemption. Previously the same submission scored 0 on the dimension.
--
-- Widening a CHECK, so nothing already stored becomes invalid and no row is rewritten.

ALTER TABLE build_probe DROP CONSTRAINT build_probe_outcome_check;
ALTER TABLE build_probe ADD CONSTRAINT build_probe_outcome_check
  CHECK (outcome IN ('RUNS', 'BUILDS_ONLY', 'BUILD_FAILED', 'UNSUPPORTED_STACK',
                     'TIMED_OUT', 'RESOURCE_EXCEEDED', 'PROBE_ERROR', 'SANDBOX_BLOCKED'));

ALTER TABLE build_probe DROP CONSTRAINT build_probe_runs_grade_check;
ALTER TABLE build_probe ADD CONSTRAINT build_probe_runs_grade_check
  CHECK (runs_grade IN ('RUNS', 'BLOCKED_BY_SANDBOX', 'BUILDS_ONLY', 'FAILS_TO_BUILD',
                        'UNSUPPORTED'));
