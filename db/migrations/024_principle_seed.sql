-- 024 — Candidate principles and standards, seeded INACTIVE (E06-S03 acceptance 4, OD-2).
--
-- Inactive by default on purpose. OD-2 is an open committee decision: adopt these, or write your
-- own list. Seeding them active would decide it by default, which is exactly the failure mode
-- finding F4 warns about for criteria and which applies here too.
--
-- Each carries an evidence specification and five anchors, so it meets the same bar E02-S05
-- applies to generated criteria: it must be checkable against a repository.

INSERT INTO arch_principle
  (code, name, description, evidence_spec, anchor_0, anchor_1, anchor_2, anchor_3, anchor_4, sort_order)
VALUES
('SEC_SECRETS', 'Secrets are not in the code',
 'Credentials are supplied by configuration rather than embedded in the repository.',
 'A reader can point to credentials being read from environment or a secret store, and can confirm no literal key appears in committed source.',
 'Live credentials are committed in the repository.',
 'Credentials appear in committed example files in a form that looks real.',
 'Credentials come from configuration, but at least one literal remains.',
 'All credentials come from configuration, with an example file carrying placeholders.',
 'All credentials come from configuration, validated at startup, with setup documented.', 1),

('SEC_INPUT', 'External input is validated',
 'Data arriving from a user, a network call or a file is checked before use.',
 'A reader can point to validation applied to an external input before it reaches storage or business logic.',
 'External input is used directly with no checks.',
 'Only presence is checked; types and ranges are not.',
 'Some entry points validate, others do not.',
 'All external entry points validate against an explicit schema.',
 'All entry points validate, and a rejection returns a specific, actionable message.', 2),

('ARCH_LAYERING', 'Concerns are separated',
 'Transport, domain logic and persistence are distinguishable.',
 'A reader can point to modules where request handling, domain logic and data access live separately, and to a call path crossing them in one direction.',
 'All logic sits in one file or inside request handlers.',
 'Some helpers are extracted, but handlers still contain domain rules.',
 'Layers exist by name but leak — handlers query storage directly.',
 'Clear layers with a one-directional dependency flow on the main path.',
 'Clear layers throughout, with the boundary enforced by types or interfaces.', 3),

('REL_ERRORS', 'Failures are handled explicitly',
 'Errors are caught, classified and reported rather than swallowed.',
 'A reader can point to code that catches a failure from an external call and either recovers, reports it, or fails with a specific message — not an empty catch.',
 'No error handling; failures propagate as unhandled exceptions.',
 'Catch blocks exist but are empty or log only.',
 'Errors are caught and logged, but a caller cannot distinguish failure from success.',
 'Errors are handled with specific messages on the main path.',
 'Errors are classified, handled, surfaced to the user, and covered by a test.', 4),

('OBS_LOGGING', 'The system can be observed',
 'Meaningful events are recorded in a form an operator could use.',
 'A reader can point to log or metric emission at the points where the system does something consequential.',
 'No logging at all.',
 'Only debug prints left in by accident.',
 'Some logging, unstructured and inconsistent.',
 'Consistent logging at consequential points, with useful context.',
 'Structured logging with correlation across a request, or metrics alongside.', 5),

('QUAL_TESTS', 'Behaviour is tested',
 'The submission carries tests exercising its own logic.',
 'A reader can point to test files, a runner configuration, and at least one assertion about the project''s own behaviour rather than a framework default.',
 'No test files.',
 'A test directory exists but holds only scaffolding or skipped tests.',
 'A few tests exist but assert trivia, or do not run.',
 'Meaningful tests covering the main path, runnable with one command.',
 'Meaningful tests covering the main path and failure cases, wired into CI.', 6),

('OPS_CONFIG', 'Configuration is externalised',
 'Behaviour that differs between environments is configuration, not a literal.',
 'A reader can point to configuration being read at startup, and to an example or default that documents what is required.',
 'Everything is hardcoded, including hostnames and ports.',
 'A few values are configurable; most are literals.',
 'Configuration exists but is scattered and partly duplicated by literals.',
 'Configuration is read in one place and documented.',
 'Configuration is read in one place, validated at startup, and a missing value fails fast.', 7),

('OPS_RUNNABLE', 'Another person could run it',
 'The repository explains how to start the project.',
 'A reader can point to a README section, a Dockerfile, or a script that states how to install and run the project.',
 'No instructions of any kind.',
 'A README exists but says nothing about running the project.',
 'Partial instructions that omit a required step.',
 'Complete instructions a reader could follow.',
 'Complete instructions plus a single command or container that runs the project.', 8),

('DATA_MODEL', 'Data has a defined shape',
 'The structures the system stores or exchanges are declared rather than implied.',
 'A reader can point to a schema, type definitions, or migrations describing the data the system handles.',
 'Data shapes are entirely implicit.',
 'Shapes are implied by ad-hoc object literals.',
 'Some structures are declared, others are not.',
 'The main structures are declared in one place.',
 'Structures are declared, versioned or migrated, and validated at the boundary.', 9)
ON CONFLICT (code) DO NOTHING;

INSERT INTO it_standard (code, name, description, evidence_spec, sort_order) VALUES
('STD_NO_SECRETS', 'No committed secrets',
 'The repository contains no live credential.',
 'A reader can confirm no file contains an API key, token or password in a usable form.', 1),
('STD_DEPENDENCY_PIN', 'Dependencies are pinned',
 'Dependency versions are fixed so a build is reproducible.',
 'A reader can point to a lockfile or pinned version specifiers in the manifest.', 2),
('STD_LICENSE', 'A licence is declared',
 'The repository states the terms under which the work may be used.',
 'A reader can point to a LICENSE file or a licence field in the manifest.', 3),
('STD_README', 'A README exists and explains the project',
 'The repository explains what the project is and how to run it.',
 'A reader can point to a README that names the project and describes running it.', 4)
ON CONFLICT (code) DO NOTHING;
