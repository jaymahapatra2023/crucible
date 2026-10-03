# codeLinc 11 — Path 1: Dental Benefits Optimizer

**Build an AI tool to simplify the dental benefits selection process.**

codeLinc 11 is Lincoln Financial's 24-hour student hackathon, 3–4 October 2026, Greensboro, NC.
Teams of three to eight choose one of two paths. This is Path 1.

## 1. The problem

Employees choosing and using an employer-sponsored dental plan face dense insurance language:
annual maximums, deductibles, coinsurance, in-network and out-of-network rates, waiting periods,
frequency limits and a plan year in which unused benefits expire. Most people cannot tell, before
a procedure, what is likely covered and what they will owe — and many leave benefits unused at
year end.

## 2. Core requirements

The tool must:

1. **Let an employee describe a planned procedure and their current plan details.** The employee
   explains, in their own words, what care they are planning (for example a crown, a filling, a
   cleaning, orthodontics) and provides their plan's terms (annual maximum, deductible,
   coinsurance by category, network status, waiting periods, frequency limits).
2. **Translate dense insurance language into a clear breakdown of what's likely covered and what
   the employee will owe.** The output is a plain-language explanation and an itemised estimate:
   what the plan pays, what the employee pays, and why — tied back to the plan terms the employee
   gave.
3. **Sequence recommended care across the plan year to help employees maximise their benefits.**
   Given more than one planned procedure, propose an order and timing across the plan year that
   makes best use of the annual maximum, deductible timing and frequency limits, and explain the
   reasoning.

## 3. Bonus features

1. **Track annual maximum usage throughout the plan year** — how much of the maximum has been
   used, how much remains, and how planned care affects it.
2. **Compare in-network vs. out-of-network costs** for the same procedure, using reference cost
   data.
3. **Remind employees of unused, end-of-year benefits before they expire** — for example a
   remaining cleaning, unused annual maximum, or a flexible spending balance.

## 4. Reference information provided to teams

1. **Dental reference information** — Lincoln DentalConnect dental health library
   (https://tinyurl.com/codelinc11dental): dental benefit basics, a glossary of dental terms, and
   descriptions of routine care (exams, cleaning, X-rays), preventive care (fluoride, sealants,
   occlusal guards, space maintainers) and procedures (bone grafts, bridges, dentures, crowns,
   implants, fillings, orthodontic treatment, periodontal maintenance and surgery, root canal
   therapy, scaling and root planing, tooth removal, veneers) and anaesthesia options.
2. **Enrollment video** (https://tinyurl.com/codelinc11dentalvideo): how employees choose a
   dental plan during enrollment.
3. **Dental cost estimator for the calculation portion** — FAIR Health Consumer, Dental Costs
   (https://www.fairhealthconsumer.org/dental/category): typical in-network and out-of-network
   costs by procedure, looked up by CDT procedure code or keyword, in categories such as
   diagnostic services, preventative, fillings, crowns, inlays and onlays, periodontal services,
   anaesthesia and medications. Teams may use it as the source of reference costs.

## 5. What a strong entry demonstrates

- **Grounded estimates.** Coverage and cost figures come from the plan details the employee
  entered and from reference cost data, never invented. Where a figure is an estimate, the tool
  says so and says what it depends on.
- **Plain language that stays correct.** Insurance terms are explained without changing what they
  mean; the employee can see the line from plan term to dollar figure.
- **A sequence with reasons.** The plan-year sequencing is explained in terms of the annual
  maximum, deductible and frequency limits, not just asserted.
- **Honest limits.** The tool distinguishes what it knows from what it is guessing, and does not
  present itself as a substitute for the plan document or the dentist's treatment plan.
- **Usable in a conversation.** An employee with no insurance vocabulary can describe their
  situation and get an answer they can act on.
- **Runs.** The application builds and starts from its repository as documented, so a judge can
  use it.

## 6. Deliverables and judging

Teams present on Sunday morning, 4 October, 10:00–12:00. Each team submits its repository. The
entry is judged on what the code does, the demo, the README, and the design documentation the team
kept while building (a spec is the team's best answer to "how did you build this?"). Prizes are
awarded at 12:45.
