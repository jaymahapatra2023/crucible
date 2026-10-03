-- 093 — The point below which an entry has probably answered a different question.
--
-- Calibration found that no choice of dimension weights fixes this. A well-built entry for the
-- OTHER challenge scored 20 of 100 on challenge fidelity and still placed mid-table, because its
-- engineering, principles and runs marks were excellent. A weighted mean cannot express "failing
-- the point disqualifies you", and it should not try: that judgement belongs to the committee.
--
-- So the ranking raises a caveat instead of bending the arithmetic, and a person decides. 35 is
-- set from the observed gap — a genuine but weak attempt at the right brief scored 53, the
-- wrong-problem entry 20 — and is configurable because the next event's rubrics will differ.
INSERT INTO app_config (key, value, value_type, description, module, editable) VALUES
('scoring.low_fidelity_threshold', '35'::jsonb, 'number',
 'Challenge fidelity below which a ranked entry is flagged for review as having possibly '
 'answered a different question than the brief asked. Raises LOW_CHALLENGE_FIDELITY, which '
 'excludes nobody — it puts the entry in front of a person with the reason.',
 'scoring', TRUE)
ON CONFLICT (key) DO NOTHING;
