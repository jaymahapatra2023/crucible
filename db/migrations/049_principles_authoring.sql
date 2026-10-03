-- 049 — Authoring principles and standards in the application (E12).
--
-- Crucible shipped nine principles and four standards as seed data with an `active` switch, on
-- the assumption that a committee adopts a list rather than writes one. That was wrong: an
-- organisation evaluating against ITS OWN guiding principles has to be able to enter them, and
-- a seeded list it cannot extend is a list it will keep outside the system, in a document the
-- evaluation never reads.
--
-- The shape follows the reference implementation's catalogue, which has the fields a real
-- principles library needs — a pillar to group by, the rationale behind it, guidance on applying
-- it, an owner, source references back to the document it came from — combined with what
-- Crucible additionally requires: an evidence specification and the five anchors, because a
-- principle here is not only published, it is SCORED against a repository on a 0–4 maturity
-- scale, and that needs wording a scorer can apply.
--
-- `target_state` and `anti_pattern` from the reference model are not added as separate columns:
-- in a scored rubric they are anchor_4 and anchor_0, and holding the same idea twice invites the
-- two to disagree.

ALTER TABLE arch_principle
  ADD COLUMN IF NOT EXISTS pillar      TEXT NOT NULL DEFAULT 'OTHER',
  ADD COLUMN IF NOT EXISTS rationale   TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS guidance    TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS source_refs TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS tags        TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS owner       TEXT,
  ADD COLUMN IF NOT EXISTS created_by  TEXT,
  ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE arch_principle
  ADD CONSTRAINT chk_principle_pillar CHECK (pillar IN (
    'SECURITY', 'RELIABILITY', 'OBSERVABILITY', 'API_FIRST', 'DATA',
    'MODULARITY', 'COST', 'DEVELOPER_EXPERIENCE', 'CLOUD_NATIVE', 'OTHER'));

ALTER TABLE it_standard
  ADD COLUMN IF NOT EXISTS category        TEXT NOT NULL DEFAULT 'ARCHITECTURE',
  ADD COLUMN IF NOT EXISTS rationale       TEXT NOT NULL DEFAULT '',
  -- A mandatory standard failing is a different conversation from an advisory one failing.
  ADD COLUMN IF NOT EXISTS mandatory       BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS applies_to      TEXT[] NOT NULL DEFAULT '{ALL}',
  ADD COLUMN IF NOT EXISTS tags            TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS source_document TEXT,
  ADD COLUMN IF NOT EXISTS owner           TEXT,
  ADD COLUMN IF NOT EXISTS effective_date  DATE,
  ADD COLUMN IF NOT EXISTS review_date     DATE,
  ADD COLUMN IF NOT EXISTS created_by      TEXT,
  ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE it_standard
  ADD CONSTRAINT chk_standard_category CHECK (category IN (
    'SECURITY', 'ARCHITECTURE', 'COMPLIANCE', 'OPERATIONAL', 'DATA_GOVERNANCE', 'OTHER'));

-- Give the seeded rows their pillars and categories, so an authored library and a seeded one
-- look the same rather than the seeds appearing as an untagged special case.
UPDATE arch_principle SET pillar = CASE
  WHEN code LIKE 'SEC_%'  THEN 'SECURITY'
  WHEN code LIKE 'REL_%'  THEN 'RELIABILITY'
  WHEN code LIKE 'OBS_%'  THEN 'OBSERVABILITY'
  WHEN code LIKE 'ARCH_%' THEN 'MODULARITY'
  WHEN code LIKE 'DATA_%' THEN 'DATA'
  WHEN code LIKE 'OPS_%'  THEN 'RELIABILITY'
  WHEN code LIKE 'QUAL_%' THEN 'DEVELOPER_EXPERIENCE'
  ELSE 'OTHER' END
WHERE pillar = 'OTHER';

UPDATE it_standard SET category = CASE
  WHEN code LIKE 'STD_NO_SECRETS%' THEN 'SECURITY'
  WHEN code LIKE 'STD_LICENSE%'    THEN 'COMPLIANCE'
  ELSE 'ARCHITECTURE' END
WHERE category = 'ARCHITECTURE';

CREATE INDEX IF NOT EXISTS idx_principle_pillar ON arch_principle (pillar, sort_order);
CREATE INDEX IF NOT EXISTS idx_standard_category ON it_standard (category, sort_order);

-- Published read models (P1.3): the catalogue as an evaluator and a UI read it.
CREATE OR REPLACE VIEW v_principle_catalogue AS
SELECT principle_id, code, pillar, name, description, rationale, guidance,
       evidence_spec, anchor_0, anchor_1, anchor_2, anchor_3, anchor_4,
       source_refs, tags, owner, active, sort_order, created_at, updated_at
FROM arch_principle;

CREATE OR REPLACE VIEW v_standard_catalogue AS
SELECT standard_id, code, category, name, description, rationale, evidence_spec,
       mandatory, applies_to, tags, source_document, owner,
       effective_date, review_date, active, sort_order, created_at, updated_at
FROM it_standard;
