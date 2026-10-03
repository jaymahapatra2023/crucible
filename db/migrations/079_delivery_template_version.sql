-- 079 — Which wording each team actually received (E43-S02, second review).
--
-- Mail templates are versioned so an organiser can reword them without a deploy. That only makes
-- the wording AUDITABLE if each delivery records which version produced its message; otherwise
-- "what did team X get?" after a rewording has no answer, and the versioning is decoration.
-- Recorded, not derived: the active version at query time is not the version at send time.

ALTER TABLE token_delivery ADD COLUMN IF NOT EXISTS template_version INTEGER;

COMMENT ON COLUMN token_delivery.template_version IS
  'The mail_template version that produced this message (E43). NULL for deliveries before versioning.';
