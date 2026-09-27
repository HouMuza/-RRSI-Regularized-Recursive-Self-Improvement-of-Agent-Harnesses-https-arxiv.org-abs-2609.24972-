# a1 experiment guide

## purpose

A1 asks whether an automated search process can improve a frozen language model
by changing only its system prompt. The model weights, decoding settings,
dataset splits, evaluator, runtime, and selection rules remain fixed.

This guide explains the full experimental hierarchy, what repeats, what may
change, how a prompt is inherited, and how to read the dashboard.

## the experimental hierarchy

A1 has six nested concepts. They should not be treated as interchangeable.

```text
proposal strategy
  run
    search
      generation
        screening evaluation
        confirmation evaluation
    evolution evaluation
    validation evaluation
    heldout test
```

### proposal strategy

A strategy is the mechanism that proposes revised system prompts.

The current strategies are:

| strategy | how candidates are created | purpose |
| --- | --- | --- |
| `deterministic` | A seeded, fixed mutation bank constructs prompt changes. | Control condition for checking the search and selection machinery. |
| `deepseek` | DeepSeek reads permitted evolution evidence and proposes prompt changes. | Adaptive proposer that can diagnose failures and create targeted revisions. |

The proposal strategy does not decide whether its candidate is good. The pinned
IFEval verifier scores every candidate, and the same deterministic selection
rule applies to both strategies.

### run

A run is one complete attempt by one proposal strategy. It receives a unique
run id and preserves its own candidates, responses, metrics, decisions, and
final evaluations.

Examples:

```text
a1-20260927-083858  deterministic
a1-20260927-135936  deepseek
```

Runs are never overwritten. A new strategy attempt receives a new run id. The
comparison drawer retains completed and active runs so results can be compared
without hiding earlier evidence.

### search

Search is the only stage allowed to select a different system prompt. Each run
performs three generations of search. Validation and heldout evidence cannot be
used during search.

### generation

A generation is one proposal and selection cycle. Each generation starts from
the current parent prompt and creates four children.

```text
generation 1: current parent -> four candidates -> possible new parent
generation 2: retained or accepted parent -> four candidates -> possible new parent
generation 3: retained or accepted parent -> four candidates -> final search winner
```

The process is recursive only when a candidate is accepted. An accepted child
becomes the parent used to create the next generation. If no child beats the
parent, the existing parent continues unchanged.

Three generations are run for each A1 run, regardless of whether the proposer
is deterministic or DeepSeek. Therefore, the deterministic control and the
DeepSeek experiment each receive the same search depth and candidate budget.

## what happens inside one generation

### step 1: propose four children

The strategy creates four complete replacement system prompts from the current
parent. Each candidate records:

- candidate id
- parent id
- full prompt
- prompt difference
- proposal rationale or hypothesis
- targeted failure modes
- generation number
- creation metadata

The candidate ids follow the generation and candidate position. For example,
`g01-c02` is candidate 2 from generation 1.

### step 2: screen all four candidates

Each candidate is evaluated on the same 32 evolution examples. The primary
metric is strict prompt accuracy.

A prompt passes one example only when every instruction in that example passes
the official verifier. A candidate with three satisfied instructions and one
failed instruction fails that complete prompt under the primary metric.

Screening is a budget saving filter. It does not allow a candidate to replace
the parent. After all four screens finish, the two candidates with the highest
scores advance.

Tie breaking follows this order:

1. higher strict instruction accuracy
2. shorter prompt length
3. candidate id

### step 3: confirm the two finalists

The two finalists and the current parent are evaluated on the same paired panel
of 96 evolution examples. Confirmation uses more evidence than screening and
compares each finalist with the parent under identical conditions.

The strongest finalist is accepted only when its strict prompt accuracy is
strictly greater than the parent's score on the same panel. A tie is not an
improvement. A lower score is a regression.

### step 4: inherit or retain

There are two possible generation outcomes:

| outcome | meaning | next generation parent |
| --- | --- | --- |
| accepted | The best finalist beat the parent on the paired confirmation panel. | The accepted child. |
| parent retained | Neither finalist beat the parent. | The existing parent. |

All rejected and screened out candidates remain in the evidence ledger. They
are scientific results, even though they are not inherited.

## complete search budget per run

The registered maximum for one strategy run is:

| item | count |
| --- | ---: |
| generations | 3 |
| proposed children per generation | 4 |
| candidate screens | 12 |
| screening examples per child | 32 |
| finalists per generation | 2 |
| candidate confirmations | 6 |
| confirmation examples per finalist | 96 |

The parent is also measured on the paired panels. Cached parent evaluations may
be reused when the prompt, panel, model, and evaluator are identical. The
counts above describe candidate evaluations and do not imply a new parent model
call is always required for every comparison.

## stages after search

After generation 3, the search winner is frozen. No later stage can change it.
The dashboard presents three paired evaluation stages after the generation
search. The runner performs the evolution evaluation automatically before its
`search` command finishes. Validation and heldout test are separate resumable
runner commands.

### evolution evaluation

The selected prompt and approved A0 baseline are compared on the full 325
example evolution split. Search had access to evolution evidence, so this
measures development performance rather than unseen generalization.

### validation

The frozen selected prompt and baseline are compared on validation examples
that were excluded from candidate selection. Validation measures transfer to
unseen examples. Its result is recorded but cannot change the selected prompt.

### heldout test

The final frozen comparison runs on sealed heldout examples. Heldout prompts,
responses, and outcomes cannot influence proposals or selection. The heldout
result is reported even when it is negative or contradicts the hypothesis.

## metrics

### primary metric

Strict prompt accuracy is the selection metric. It is the share of prompts for
which every instruction passes.

```text
strict prompt accuracy = fully passing prompts / scored prompts
```

### secondary metrics

- Strict instruction accuracy counts individual instructions that pass.
- Loose prompt accuracy allows registered formatting tolerance.
- Loose instruction accuracy applies the loose check at instruction level.
- Token counts and latency measure execution cost.
- Prompt length and edit size describe mutation complexity.

A high strict instruction score with a lower strict prompt score usually means
the model satisfies many individual requirements but misses at least one
requirement in several multi-constraint prompts.

### percentage point changes

Dashboard deltas are percentage point changes, not relative percentage gains.

```text
candidate 66.0% minus parent 64.0% = +2.0 percentage points
```

Partial live scores can change substantially while examples are still being
scored. They are evidence of current progress, not final results.

## how to read the search dashboard

### current evaluation

The progress bar shows which candidate is being generated and scored now. The
live checkpoint graph shows how its metrics change as verifier checkpoints are
written.

Very small samples can be misleading. For example, one passing result appears
as 100 percent at `1/1`. The dashboard labels this as too early for a useful
comparison until more evidence is available.

### generation screening results

This graph keeps all four candidates visible throughout the generation:

- blue bars are completed 32 example screen scores
- orange is the active partial screen score
- empty rows have not run yet
- the dashed green line is the parent reference

A completed candidate remains visible when the next candidate starts. The
screening graph answers how each of the four candidates performed, but it does
not show an accepted improvement until confirmation is complete.

### improvement across generations

This graph tracks confirmed generation outcomes against their parents. A point
above the parent indicates a confirmed improvement. A point below the parent
indicates regression. If the parent is retained, the next generation continues
from the same prompt.

### candidate ledger

The ledger explains what change each candidate tested and why it ended with its
recorded status:

| status | interpretation |
| --- | --- |
| testing now | The candidate is actively being evaluated. |
| screen complete | The 32 example screen is final, but the generation ranking is not yet final. |
| stopped after screen | The candidate did not place in the top two. |
| not adopted | The candidate reached confirmation but did not beat the parent. |
| adopted | The candidate beat the parent and became the next generation parent. |
| current parent | The prompt that new children inherit from. |

### run comparison drawer

The drawer compares independent strategy runs. It shows preserved runs,
accepted changes, completed final evaluations, and stage deltas against the A0
baseline. Pending stages remain pending rather than being displayed as zero.
Selecting a row opens that run's complete stage evidence.

## deterministic and deepseek comparability

The two strategy runs share:

- frozen Qwen model and revision
- dataset and split membership
- decoding settings
- official IFEval verifier
- three generations
- four children per generation
- 32 example screening panels
- 96 example confirmation panels
- acceptance rule
- final evaluation stages

They differ only in how candidate prompts are proposed. This isolates proposal
quality while holding evaluation and selection constant.

DeepSeek receives only registered evolution evidence. It cannot inspect
validation or heldout data. DeepSeek proposes changes, while IFEval and the
paired acceptance rule decide whether those changes are inherited.

## what can be concluded from one run per strategy

One deterministic run and one DeepSeek run provide a controlled comparison of
the recorded outcomes. They do not estimate run to run variance or establish
that one strategy is generally superior.

A stronger strategy comparison requires multiple independent runs or seeds per
strategy under matched budgets. That later analysis should report:

- acceptance rate across runs
- distribution of final evolution deltas
- distribution of validation and heldout deltas
- variance and confidence intervals
- proposal and evaluation cost
- frequency of search gains that fail to transfer

The current A1 runs establish whether the machinery works and whether either
registered attempt discovers an accepted prompt. Broader claims require the
replicated experiment described above.

## evidence and reproducibility

Canonical evidence is stored under:

```text
runs/a1/experiments/<run-id>/
```

Each run preserves its manifest, proposal records, candidates, evaluations,
generation decisions, final comparisons, and MLflow linkage. Search can resume
from durable records after interruption. A run id must not change between its
search, evolution, validation, and heldout stages.

The exact registered rules remain authoritative in:

- [`preregistration.md`](../phase-a/a1-prompt-evolution/preregistration.md)
- [`deepseek_preregistration.md`](../phase-a/a1-prompt-evolution/deepseek_preregistration.md)
- [`config.json`](../phase-a/a1-prompt-evolution/config.json)
