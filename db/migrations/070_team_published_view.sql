-- 070 — Teams, published for other modules to read (P1.3, ADR 0002).
--
-- E28 gave the roster four readiness checks, and every one of them reads `team` — a table the
-- **submissions** module owns. Appendix C allows a module to read another's data only through a
-- published `v_*` view, and this one did not exist, so four queries reached across the boundary
-- into a base table. Nothing failed, which is exactly why it needed finding: the checks work
-- until the day `team` changes shape, and then a module that never asked for a dependency has
-- one anyway.
--
-- What is published is what a reader outside submissions legitimately needs: who the team is, how
-- it is reached, and how it came to exist. `updated_at` and `created_by` are not here — they are
-- submissions' own bookkeeping.

CREATE OR REPLACE VIEW v_team AS
SELECT team_id,
       display_name,
       -- The comparable form, so a reader matching on name uses the owning module's definition
       -- rather than reimplementing it (P1.5 clause 6).
       normalised_name,
       -- '' where a team was created before anybody was on it. Empty, not NULL, because that is
       -- what the column holds; a reader deciding whether a team can be contacted must treat
       -- both as "no address" and `rosterReadiness` does.
       contact_email,
       origin,
       created_at
FROM team;

COMMENT ON VIEW v_team IS
  'Published team identity for modules outside submissions (ADR 0002). Read this, never `team`.';
