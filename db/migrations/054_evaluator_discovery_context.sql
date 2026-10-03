-- 054 — The evaluators read from discovery (E12, ADR 0003).
--
-- Discovery is the evidence base the evaluation reads from, not a parallel description beside
-- it. The principles and standards evaluators now receive what the extractors found alongside
-- the source excerpts they already get, so a principle about layering is assessed by someone who
-- has been told where the layers are.
--
-- Version 2 rather than an edit in place: a prompt is content-addressed and a score records the
-- template it ran under (P3.3), so changing v1's body would retroactively misattribute every
-- score already taken. v1 is deactivated; its row stays.
--
-- The two guards from the ADR are written into the prompt body itself, because they are the
-- things most easily lost:
--   * discovery is ADDITIONAL context, never a replacement for reading the code;
--   * a concern discovery could not extract is passed as NOT DETERMINED, and must never be
--     read as "the repository has none".

UPDATE llm_call_registry
   SET input_variables = ARRAY['principle_code','principle_name','principle_description',
                               'evidence_spec','anchor_0','anchor_1','anchor_2','anchor_3',
                               'anchor_4','repo_summary','discovery_context']
 WHERE call_key = 'scoring.principles';

UPDATE llm_call_registry
   SET input_variables = ARRAY['standard_code','standard_name','standard_description',
                               'evidence_spec','repo_summary','discovery_context']
 WHERE call_key = 'scoring.standards';

-- A partial unique index allows one ACTIVE template per (call_key, role), so v1 stands down
-- before v2 is inserted rather than after. Its row stays: a score taken under v1 records that
-- version, and deleting it would leave that score unexplainable (P3.3).
UPDATE llm_prompt_template
   SET active = FALSE
 WHERE call_key IN ('scoring.principles', 'scoring.standards') AND version = 1;

-- The system prompts are unchanged in substance; v2 adds the paragraph governing how the
-- discovery section is to be used. Copied from v1 with that paragraph appended, so the two
-- versions differ only where intended.
INSERT INTO llm_prompt_template (call_key, version, role, body, content_hash, active)
SELECT call_key, 2, 'system',
       body || E'\n\nWHAT DISCOVERY GIVES YOU\nYou will also be shown what a separate discovery pass extracted from this repository: its\nendpoints, data model, capabilities, integrations, stack and security observations.\n\nUse it as a map, not as evidence. It tells you where to look and what exists; your verdict must\nstill rest on the source excerpts you were given, and your citations must come from them.\n\nWhere a concern reads NOT DETERMINED, the discovery pass could not read enough to answer. That\nis a statement about the pass, not about the repository. Do not conclude that the thing is\nabsent, and never mark a team down for it.',
       repeat('0', 64), TRUE
  FROM llm_prompt_template
 WHERE call_key IN ('scoring.principles', 'scoring.standards')
   AND role = 'system' AND version = 1
ON CONFLICT (call_key, role, version) DO NOTHING;

INSERT INTO llm_prompt_template (call_key, version, role, body, content_hash, active)
SELECT call_key, 2, 'user',
       replace(body, E'Return JSON only',
               E'WHAT DISCOVERY EXTRACTED FROM THIS REPOSITORY\n{{discovery_context}}\n\nReturn JSON only'),
       repeat('0', 64), TRUE
  FROM llm_prompt_template
 WHERE call_key IN ('scoring.principles', 'scoring.standards')
   AND role = 'user' AND version = 1
ON CONFLICT (call_key, role, version) DO NOTHING;

UPDATE llm_prompt_template
   SET content_hash = encode(sha256(convert_to(body, 'UTF8')), 'hex')
 WHERE content_hash = repeat('0', 64);
