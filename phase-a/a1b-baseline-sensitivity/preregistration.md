# a1b baseline sensitivity preregistration

## research question

Does recursive prompt search produce larger confirmed improvements when the
starting system prompt contains more identifiable weaknesses or conflicts?

## hypotheses

1. Empty, ordinary, and conflicting starting prompts will provide more
   improvement headroom than concise expert and current prompts.
2. The conflicting condition will benefit when search removes instructions for
   introductions, conclusions, and unnecessary detail.
3. Strong concise baselines will accept fewer mutations because their remaining
   candidates are more likely to regress.
4. Any accepted evolution gain may fail to transfer to validation or heldout
   examples, and every such failure will be reported.

Evidence against these hypotheses includes no accepted mutations for weak
conditions, similar gains across every starting condition, or gains that do not
survive the paired confirmation rule.

## frozen baseline conditions

The five conditions and their exact prompt strings are frozen in
[`baselines.json`](baselines.json). The labels describe the intended design
role. They are not claims that a population of human writers produced the
prompts.

No condition may be edited after its first response is generated. A changed
prompt requires a new condition id and a new preregistration revision.

## matched protocol

Every condition uses the same model, dataset split, evaluator, decoding,
three-generation search, four children per generation, 32 example screen,
96 example confirmation, two finalists, and strictly positive acceptance rule
used in A1.

Each condition is evaluated with both deterministic and DeepSeek proposal
strategies. The completed current-condition A1 runs remain historical evidence.
A1b must not relabel those prior runs as preregistered A1b replications.

## comparison plan

Report results within each starting condition first. The primary condition
result is the final selected prompt's paired strict prompt accuracy difference
from that condition's starting prompt.

Across conditions, plot starting accuracy against:

- accepted mutation count
- best confirmation delta
- final evolution delta
- validation delta
- heldout delta
- prompt word change
- generation and token cost

This first matched pass contains one run for each strategy and condition. It is
a baseline sensitivity pilot and cannot estimate strategy variance. Any later
replication count, seeds, and stopping rule must be registered before those
runs begin.

## leakage and selection

Only evolution evidence may reach either proposer. Validation and heldout
results cannot select a prompt, alter a condition, or change the search budget.
Heldout results are opened once per completed condition run after validation.

## gate

A1b supports moving to A2 only if at least one nontrivial starting condition
produces an accepted change and the full evidence pack is complete. Transfer is
then characterized in A2. If no condition improves, revise the mutation space
or model capability assumption before studying overfitting.
