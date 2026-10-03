-- 086 — Recoverable submission tokens (E47-S02, ADR 0005).
--
-- The plaintext is stored ENCRYPTED beside the hash, with the key in the environment, and read
-- back only through one audited, admin-only act. The hash stays the only thing verification
-- uses. The ciphertext is purged when the window locks and when a token is revoked.
--
-- `cipher_key_id` names which key sealed the row, so a rotated key reports "unavailable" rather
-- than failing to decrypt; `cipher_purged_at` records that a null ciphertext is a choice, not a
-- token issued before the key existed.

ALTER TABLE access_token
  ADD COLUMN IF NOT EXISTS token_cipher     TEXT,
  ADD COLUMN IF NOT EXISTS cipher_key_id    TEXT,
  ADD COLUMN IF NOT EXISTS cipher_purged_at TIMESTAMPTZ;

COMMENT ON COLUMN access_token.token_cipher IS
  'AES-256-GCM of the plaintext under TOKEN_REVEAL_KEY (ADR 0005). Never used for verification.';

INSERT INTO app_config (key, value, value_type, description, module, editable, affects_outcome)
VALUES
  ('http.ceiling_token_reveal_per_hour', '120'::jsonb, 'number',
   'Reveals one admin credential may perform in an hour (E47-S02, ADR 0005). Forty teams, each looked up three times, is 120; this is a security limit, not a breaker.',
   'submissions', TRUE, FALSE)
ON CONFLICT (key) DO NOTHING;

INSERT INTO feature_flag (key, enabled, description) VALUES
('feature.submissions.token_reveal', TRUE,
 'Let an admin reveal a team''s current submission code (ADR 0005). Off, reveal reports unavailable; issuing still seals, so nothing is lost by switching it back on.')
ON CONFLICT (key) DO NOTHING;
