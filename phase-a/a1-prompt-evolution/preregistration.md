# a1 preregistration

## research question

Can a recursive, prompt-only mutation and selection loop improve the frozen
Qwen3-0.6B IFEval harness relative to the approved a0 baseline while retaining
the improvement on validation and held-out examples?

## hypotheses

- The selected prompt will improve strict prompt accuracy on the complete
  evolution split relative to a0.
- The direction of the improvement will remain positive on validation.
- The final held-out comparison will be reported regardless of outcome.

Evidence against the hypothesis includes no accepted mutation, a positive
evolution result with a non-positive validation result, or a final held-out
regression.

## frozen baseline

The baseline is `a0-20260926-180736`. Its model, evaluator, dataset, split
membership, decoding settings, device, and initial system prompt are frozen.
The only mutable value in a1 is the evaluated agent's system prompt.

## mutation protocol

The search runs for three generations. Each generation proposes four children
of the current incumbent. Mutation operators add or refine instructions for
constraint inventory, exact counts, negative constraints, output structure,
and final response auditing. The seeded operator schedule is deterministic.

Each mutation records its parent, complete prompt, prompt diff, operator,
rationale, word-count delta, generation, and creation time. Rejected and failed
candidates remain in the ledger.

## selection protocol

Each generation uses deterministic nested evolution panels:

1. Evaluate four children and the incumbent on 32 evolution examples.
2. Advance the two children with the best strict prompt accuracy.
3. Evaluate those two children and the incumbent on 96 evolution examples.
4. Accept the best child only when its paired strict prompt accuracy is greater
   than the incumbent's score on the same 96 examples.

Ties are resolved by strict instruction accuracy, then shorter prompt length,
then candidate id. The accepted child becomes the next generation's parent.

After generation three, evaluate the final incumbent on all 325 evolution
examples. Compare it with the existing a0 responses on the identical examples.

## validation and held-out policy

Validation is evaluated once after the complete evolution search has selected
the final incumbent. Validation cannot change the selected prompt.

Held-out evaluation runs once after validation. Neither held-out prompts nor
per-example held-out outcomes are exposed to the mutation or selection loop.
The held-out result is reported even when it contradicts the hypothesis.

## primary and secondary measures

The primary measure is paired strict prompt accuracy difference against a0.
Secondary measures are strict instruction accuracy, loose prompt accuracy,
loose instruction accuracy, prompt word count, edit size, generation latency,
input tokens, and output tokens. All measures are reported separately.

Paired prompt outcomes will include a bootstrap confidence interval in the
final evidence pack. No composite quality and complexity score is used in a1.

## stopping and deviations

The search stops after three generations or when execution cannot continue
without changing a frozen variable. Crashes may be resumed from durable JSONL
records. Any change to this protocol after candidate scoring begins is recorded
as a deviation and requires a new experiment id.
