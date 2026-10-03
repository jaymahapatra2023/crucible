-- 090 — Coach sheets (E51).
--
-- A coach sitting with a shortlisted team during its presentation needs, on one page, what the
-- evaluation found and the questions it raises: the weakest criteria with the evidence behind
-- them, claims the README makes that the code did not show, whether it ran, how much of it is
-- template, where the two runs disagreed. The sheet is composed from evidence already on record;
-- nothing here scores anything.
--
-- Two things the review module needs that it could not read before: criterion NAMES (a score
-- row carries only the id — a coach cannot ask about "criterion 41"), published here by the
-- rubrics module; and a record of which coach was sent which sheets, so "did the coaches get
-- them" is answerable.

CREATE OR REPLACE VIEW v_rubrics_criterion AS
SELECT criterion_id, rubric_id, dimension, name, description, weight, sort_order
FROM rubric_criterion;

CREATE TABLE IF NOT EXISTS coach_dispatch (
  dispatch_id   BIGSERIAL    PRIMARY KEY,
  run_index_id  BIGINT       NOT NULL,
  -- The coach and the teams, as ids (ADR 0002). The address is in the roster, not here.
  coach_id      BIGINT       NOT NULL,
  team_ids      BIGINT[]     NOT NULL,
  status        TEXT         NOT NULL CHECK (status IN ('SENT', 'PREPARED', 'FAILED')),
  provider      TEXT         NOT NULL,
  detail        TEXT,
  provider_ref  TEXT,
  sent_by       TEXT         NOT NULL,
  sent_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_coach_dispatch_run ON coach_dispatch (run_index_id, sent_at DESC);

INSERT INTO mail_template (mail_key, version, subject, body, variables, content_hash, created_by)
VALUES (
  'mail.coach_sheet', 1,
  'Coach sheets for your {{count}} shortlisted team{{plural}}',
$BODY$Hello {{coach_name}},

Below is a sheet for each shortlisted team you coach: what the evaluation found, and questions
worth asking during their presentation. The scores are confidential until the results are
announced — use the sheet to ask, not to tell.

{{sheets}}

If a sheet looks wrong, or a team you coach is missing, ask an organiser.$BODY$,
  ARRAY['coach_name', 'count', 'plural', 'sheets'],
  repeat('0', 64), 'migration'
)
ON CONFLICT (mail_key, version) DO NOTHING;

UPDATE mail_template
   SET content_hash = encode(sha256(convert_to(subject || E'\n' || body, 'UTF8')), 'hex')
 WHERE content_hash = repeat('0', 64);
