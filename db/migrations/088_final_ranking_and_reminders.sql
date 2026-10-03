-- 088 — The end-to-end review (E50): a final ranking from both runs, and reminders.
--
-- 1. Final ranking. Each cohort is scored twice; until now each run was ranked on its own and the
--    two were only COMPARED (E06-S06). The event's result is one ordering, so the two composites
--    are combined per submission — weighted mean, weights in config — and ranked with the same
--    tie rule. The per-run rankings stay, as the evidence behind the number; disagreement between
--    runs is still flagged, on the final row, so averaging cannot hide it.
--
-- 2. Reminders. A team that registered and has not submitted, or whose entry has problems it has
--    not fixed, is told so by an organiser's act — recorded per team, like every other message.
--
-- 3. The tier-1 walk budget is retired: its checks moved to pre-flight (README and substantive
--    code are findings a team fixes, not refusals). The floor stays and is read there.

CREATE TABLE IF NOT EXISTS cohort_final_ranking (
  id                   BIGSERIAL    PRIMARY KEY,
  cohort_key           TEXT         NOT NULL,
  submission_id        BIGINT       NOT NULL,
  challenge_id         BIGINT       NOT NULL,
  team_name            TEXT,
  composite_run1       NUMERIC(6,3),
  composite_run2       NUMERIC(6,3),
  -- The weighted mean. When one run lacks the submission, the other's composite stands and
  -- `single_run` says so rather than the average silently halving it.
  composite_final      NUMERIC(6,3) NOT NULL,
  single_run           BOOLEAN      NOT NULL DEFAULT FALSE,
  delta                NUMERIC(6,3),
  rank_global          INTEGER      NOT NULL,
  rank_in_challenge    INTEGER      NOT NULL,
  tied                 BOOLEAN      NOT NULL DEFAULT FALSE,
  in_cut_band          BOOLEAN      NOT NULL DEFAULT FALSE,
  -- The runs disagree by more than the threshold, or straddle the cut line: a human looks.
  disagreement         BOOLEAN      NOT NULL DEFAULT FALSE,
  partial              BOOLEAN      NOT NULL DEFAULT FALSE,
  UNIQUE (cohort_key, submission_id)
);

CREATE TABLE IF NOT EXISTS cohort_final_snapshot (
  cohort_key       TEXT         PRIMARY KEY,
  run1_index_id    BIGINT       NOT NULL,
  run2_index_id    BIGINT       NOT NULL,
  weights          JSONB        NOT NULL,
  cut_line_used    INTEGER      NOT NULL,
  band_size_used   INTEGER      NOT NULL,
  threshold_used   NUMERIC(6,3) NOT NULL,
  submissions      INTEGER      NOT NULL,
  computed_by      TEXT,
  computed_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE OR REPLACE VIEW v_scoring_final_ranking AS
SELECT cohort_key, submission_id, challenge_id, team_name, composite_run1, composite_run2,
       composite_final, single_run, delta, rank_global, rank_in_challenge, tied, in_cut_band,
       disagreement, partial
FROM cohort_final_ranking;

CREATE TABLE IF NOT EXISTS team_reminder (
  reminder_id  BIGSERIAL    PRIMARY KEY,
  team_id      BIGINT       NOT NULL,
  kind         TEXT         NOT NULL CHECK (kind IN ('NOT_SUBMITTED', 'PROBLEMS')),
  status       TEXT         NOT NULL CHECK (status IN ('SENT', 'PREPARED', 'FAILED')),
  channel      TEXT         NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'discord')),
  provider     TEXT         NOT NULL,
  detail       TEXT,
  provider_ref TEXT,
  sent_by      TEXT         NOT NULL,
  sent_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_team_reminder_team ON team_reminder (team_id, sent_at DESC);

INSERT INTO app_config (key, value, value_type, description, module, editable, affects_outcome)
VALUES
  ('scoring.run_weights', '{"1": 0.5, "2": 0.5}'::jsonb, 'json',
   'Weight of each scoring run in the final composite (E50). Equal by default; must sum to 1.',
   'scoring', TRUE, TRUE)
ON CONFLICT (key) DO NOTHING;

DELETE FROM app_config WHERE key = 'submissions.tier1_budget_ms';

INSERT INTO mail_template (mail_key, version, subject, body, variables, content_hash, created_by)
VALUES (
  'mail.submission_reminder', 1,
  '{{team_name}} — {{situation_short}}',
$BODY$Hello {{team_name}},

{{situation}}

Entries close at {{closes_at}}. Anything on your default branch at that moment is what gets
evaluated, and an entry that was never submitted cannot be.

What to do: go to {{submit_url}}, paste your submission code, and submit. If you have already
submitted and this is about problems found in your entry, fix them and submit again — the checks
run again automatically.

If you have lost your code, or you believe this message is wrong, ask an organiser.$BODY$,
  ARRAY['team_name', 'situation_short', 'situation', 'closes_at', 'submit_url'],
  repeat('0', 64), 'migration'
)
ON CONFLICT (mail_key, version) DO NOTHING;

UPDATE mail_template
   SET content_hash = encode(sha256(convert_to(subject || E'\n' || body, 'UTF8')), 'hex')
 WHERE content_hash = repeat('0', 64);
