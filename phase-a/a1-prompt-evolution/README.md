# a1: prompt evolution

## purpose

Test whether automated mutation and selection can improve a frozen model by
changing only its system prompt.

## locked variables

The evaluated model and weights, tools, runtime, task data, evaluator, and
selection protocol are fixed. Only the system prompt is mutable. The improver
may inspect only the information allowed by the pre-registered protocol.

## start condition

a0 is complete, its evidence pack is reproducible, and the project owner has
explicitly approved the a0 gate. This directory is a plan only until then.

## required outputs

Keep the initial prompt, every proposed prompt and rationale, parent and child
lineage, evaluation outcomes, selection decisions, failed candidates, cost,
and final held-out results. Include a frozen baseline comparison and uncertainty
estimates.
