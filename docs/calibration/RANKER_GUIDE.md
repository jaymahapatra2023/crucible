# Ranking a golden set — what to do

Thank you for doing this. It takes about 90 minutes and it is the only thing that tells us whether
Crucible's ordering can be trusted to help decide the event.

You have **eight repositories**. Put them in order, **best first**, and send the ordering back.
That is the whole task.

## Before you start, three things

1. **Do not discuss them with the other rankers until all three orderings are in.** Independence
   is the entire value of the exercise. If two of you compare notes, we learn nothing from the
   fact that you agreed.
2. **Do not look at what the machine said.** You will not be shown it, and that is deliberate.
3. **Rank all eight.** A partial ordering cannot be compared against a full one, and the tool
   will refuse it.

## What you are judging

The same thing a coach would judge on the night: how well the entry answers the brief it was
submitted against. Read the brief first — `path-1-dental-benefits-optimizer.md` or
`path-2-life-insurance-needs-analyzer.md` in `docs/challenges/codelinc11/` — and then read the
repositories against it.

What the rubric asks, in plain terms:

- **Does it do what the brief asked?** Are the core requirements actually implemented, or only
  described in the README?
- **Are the numbers real?** Whether the figures it shows are computed by the code from what the
  user entered, or produced by a language model and displayed. This matters more than it may
  sound: a figure nobody can re-derive is a figure nobody can check.
- **Does it explain itself?** Can a user see why the answer is what it is, and change an input
  and see the effect?
- **Is it honest?** Does it distinguish what it knows from what it is estimating, and say it is
  not a substitute for the plan document or for professional advice?
- **Is it built with care?** Tests on the part that matters, a failure that does not lose the
  user's work, no credentials in the repository, and restraint with personal answers.
- **Does it run?** A README that tells you how to start it, and a container that does.

## How to work through one repository

Ten minutes each is enough. A route that works:

1. Read the README. What does it claim?
2. Look for where the numbers are produced. Is there a module that computes them? Is it tested?
3. Check one claim from the README against the code.
4. Look at the log statements and any config file: is a key committed, are the user's answers
   being written down?
5. Note one sentence on why it sits where you put it.

## What to send back

A list of the eight labels, best first, exactly as written in the set — `Reference A1`,
`Reference A2` and so on. One per line. Plus, if you have them, your one-line notes; they are not
required but they make the report far more useful when the machine disagrees with you.

Send it to the organiser who asked you, **not** to the other rankers.

## What happens next

The three orderings are compared with each other and with Crucible's. Where you and it disagree
by three places or more, that disagreement is read individually with the evidence Crucible cited.
If the agreement is close enough against thresholds written down before anyone saw the result, the
system is cleared to rank the real event. If it is not, the event is judged by people and Crucible
supplies evidence only. Both outcomes are fine; the point is to know which one we are in.
