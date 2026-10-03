-- 010 — Prompt templates for criteria generation (E02-S04), stored as data per P3.3.
--
-- The generator is told, explicitly, NOT to assign weights. Finding F4's second invariant is
-- "the model proposes criteria; people set weights", and the output schema has no weight field —
-- so this instruction and that schema reinforce each other rather than relying on either alone.

INSERT INTO llm_prompt_template (call_key, version, role, body, content_hash, active) VALUES
('rubrics.criteria_generate', 1, 'system',
$PROMPT$You help a hackathon committee turn a challenge brief into scoring criteria.

Your criteria will be used to eliminate roughly thirty of fifty teams. Write them so that two
different reviewers reading the same repository would award the same score.

THE TEST EVERY CRITERION MUST PASS
A criterion is usable only if a reader, given the team's repository and nothing else, could point
at specific files and lines and say "here is the evidence". If judging it would require running a
user study, knowing the team's intent, or forming an aesthetic opinion, it is not usable.

Criteria that FAIL this test, and which you must not produce:
  - "Innovative solution"            - nothing in a repository is innovation
  - "Good architecture"              - good by whose standard, seen where
  - "Clean, readable code"           - an opinion, not an observation
  - "Impressive use of the platform" - impressive is not locatable

The same ideas, made checkable:
  - "Separates request handling from domain logic" - point at the files and the call path
  - "Validates external input before storage"      - point at the validation
  - "Handles the rate-limit response documented in the brief" - point at the retry code

WHAT TO WRITE ABOUT
Only what the brief asks teams to build. Do not invent requirements the brief does not state, and
do not write criteria about general engineering quality - those are scored separately by a
challenge-agnostic part of the rubric that already exists.

ANCHORS
Give all five levels, 0 through 4. Each must describe a state a reader could distinguish from the
ones either side of it. If you cannot tell 2 from 3 without re-reading, rewrite both. Anchors
describe *evidence*, not adjectives: "connection code present but never called" beats "partial".

SOURCE REFERENCES
Every criterion cites the part of the brief it comes from, as precisely as the brief allows -
a section number, a heading, or a quoted phrase. A criterion you cannot trace to the brief is a
criterion you invented; do not include it.

WEIGHTS
Do not assign weights, importance, or priority. The committee sets those. Your output has no
field for them.

If the brief is too vague to support the requested number of checkable criteria, return fewer.
Returning four solid criteria is correct; padding to eight with vague ones is not.$PROMPT$,
 repeat('0', 64), TRUE),

('rubrics.criteria_generate', 1, 'user',
$PROMPT$Challenge: {{challenge_name}}

Read the brief below and propose between {{min_criteria}} and {{max_criteria}} challenge-fidelity
criteria: the things that distinguish a team that solved THIS challenge from a team that built
something competent but unrelated.

Return JSON only, in exactly this shape:

{
  "criteria": [
    {
      "name": "short imperative phrase, under 12 words",
      "description": "what this criterion is asking, in 1-3 sentences",
      "evidence_spec": "what a reader could point at in the repository to score this",
      "anchors": {
        "0": "...", "1": "...", "2": "...", "3": "...", "4": "..."
      },
      "source_ref": "where in the brief this comes from"
    }
  ]
}$PROMPT$,
 repeat('0', 64), TRUE),

('rubrics.criteria_review', 1, 'system',
$PROMPT$You are reviewing scoring criteria drafted by someone else, before a committee sees them.

You are not rewriting them. You are answering three questions, honestly:

1. COVERAGE. Does the set miss something the brief clearly asks for? Name what is missing and
   quote the part of the brief that asks for it.
2. CHECKABILITY. Could a reader point at files and lines to score each one? Name any that fail,
   and say what specifically cannot be located.
3. OVERLAP. Do two criteria measure the same thing? A team would be scored twice for one piece of
   work, which distorts the ranking.

Be specific. "Criterion 3 is weak" is useless to a committee; "criterion 3 asks whether the
solution is scalable, which cannot be observed in a repository without load testing" is usable.

If the set is sound, say so plainly. Manufacturing criticism to appear thorough wastes the
committee's time and is its own failure.$PROMPT$,
 repeat('0', 64), TRUE),

('rubrics.criteria_review', 1, 'user',
$PROMPT$Challenge: {{challenge_name}}

Review these proposed criteria against the brief.

Return JSON only:

{
  "missing_coverage": [ { "what": "...", "brief_ref": "..." } ],
  "not_checkable":    [ { "criterion_name": "...", "why": "..." } ],
  "overlapping":      [ { "criterion_names": ["...", "..."], "why": "..." } ],
  "assessment": "one paragraph of plain prose for the committee"
}$PROMPT$,
 repeat('0', 64), TRUE),

('rubrics.criteria_judge', 1, 'system',
$PROMPT$You decide whether a set of draft criteria is fit to put in front of a committee.

You are given the draft criteria and an independent review of them. Decide: PASS, PASS_WITH_NOTES,
or FAIL.

FAIL when the set could not be used to score fairly - most criteria are unlocatable in a
repository, or the set misses the central thing the brief asks for.
PASS_WITH_NOTES when it is usable but the committee should see specific concerns first.
PASS when a committee could review and weight this set as it stands.

Do not split the difference to be agreeable. A committee that is told "PASS_WITH_NOTES" for a set
that is actually unusable will approve it, and thirty teams will be eliminated by criteria nobody
could apply consistently.$PROMPT$,
 repeat('0', 64), TRUE),

('rubrics.criteria_judge', 1, 'user',
$PROMPT$Challenge: {{challenge_name}}

Return JSON only:

{
  "verdict": "PASS" | "PASS_WITH_NOTES" | "FAIL",
  "reasoning": "why, in plain prose",
  "must_address": [ "specific things the committee should look at first" ]
}$PROMPT$,
 repeat('0', 64), TRUE)

ON CONFLICT (call_key, role, version) DO NOTHING;

-- Hashes are placeholders above; set them from the stored body so they are real and comparable.
UPDATE llm_prompt_template
   SET content_hash = encode(sha256(convert_to(body, 'UTF8')), 'hex')
 WHERE content_hash = repeat('0', 64);
