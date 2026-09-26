# research plan

## objective

Test whether an agent harness can be improved recursively while retaining or
improving performance on unseen tasks, and determine how the result changes as
the set of allowed mutations expands.

The programme separates three questions that should not be conflated:

1. Does the recursive improvement and evaluation machinery work?
2. Can the machinery evolve a broader software system, beyond prompts?
3. Does that machinery produce useful behavior in a realistic simulated bank?

The bank world is developed independently from the rsi proof-of-machinery work.
This keeps the initial experiments small and makes the later banking results
easier to interpret.

## phase a: prove the rsi machinery

### a0: evaluation infrastructure

Create a frozen task environment, reproducible data splits, scoring, model
adapters, mutation lineage, run manifests, raw result storage, and experiment
tracking. Establish repeatability before any component is allowed to improve.

**Gate:** a clean baseline run can be reproduced, and the evidence pack contains
the configuration, data and evaluator fingerprints, per-example results,
aggregate metrics, cost, and lineage.

### a1: prompt evolution

Allow the improver to edit only the evaluated model's system prompt. All other
variables are fixed. Compare every candidate against the same evaluation
protocol and preserve every proposal, including rejected proposals.

**Gate:** demonstrate repeatable improvement over the static baseline with
complete lineage and a held-out evaluation. The project owner reviews the
evidence before a2 begins.

**Relationship to the rrsi paper:** a1 is a prompt-only baseline experiment,
not a full reproduction. The paper's harness edit space includes control flow,
configuration, tools, context management, skills, memory, and subagents. See
[`paper_rrsi.md`](paper_rrsi.md) for the paper summary and design implications.

### a2: characterize overfitting

Run prompt optimization against the evolution split and measure whether gains
transfer to validation and held-out tasks. Characterize how performance changes
over generations and across task families.

**Gate:** document whether overfitting occurred, its measured form, and the
uncertainty around the result.

### a3: regularized recursive improvement

Introduce explicitly specified proposal and selection controls informed by the
rrsi paper, such as an annealed edit budget, mutation history, leakage
screening, noise-aware acceptance, gain-dependent cost rules, and pruning.
Compare naive prompt evolution with the regularized method under matched
budgets and seeds. Use a validation split only if its selection role is
pre-registered. Reserve the held-out test split for the final transfer
evaluation. See [`paper_rrsi.md`](paper_rrsi.md) for the distinction between
the paper's rules and our proposed adaptation.

**Gate:** support any generalization claim with frozen held-out results,
uncertainty estimates, cost accounting, and full mutation lineage.

## phase b: prove heterogeneous software evolution

Use a small synthetic environment where useful structure is not prescribed in
advance. Keep every capability locked until its predecessor is reviewed.

- **b1: parameters and rules.** Evolve deterministic thresholds, rules, and
  configuration.
- **b2: executable code.** Permit controlled code patches, module creation,
  routing, and workflow changes inside a restricted runtime.
- **b3: conventional machine learning.** Permit dataset creation, feature
  selection, model training, threshold selection, and model deployment or
  removal using generic primitives.
- **b4: structural evolution.** Permit generic component and agent creation or
  deletion, tool assignment, and route changes.
- **b5: heterogeneous evolution.** Select among code, rules, machine learning,
  language models, agents, and routing under measured performance, cost, and
  complexity constraints.

**phase gate:** show that the mutation and selection machinery is reliable for
each added capability before enabling the next. Report security boundaries and
runtime constraints for executable changes.

## phase c: build the simulated bank world

Develop the bank as a separate, versioned laboratory environment. First verify
the simulator without recursive evolution.

- **c0: ledger, customers, accounts, and transactions.**
- **c1: retail banking, payments, cards, and products.**
- **c2: commercial banking, lending, facilities, drawdowns, credit assessments,
  and covenants.**
- **c3: CRM, relationship managers, teams, tasks, and opportunities.**
- **c4: unstructured information such as email, meeting notes, call transcripts,
  financial statements, credit papers, and policies.**
- **c5: temporal simulation in which events change state over time.**

**Gate:** validate simulator invariants, scenario coverage, and reproducibility
before connecting any evolutionary system.

## phase d: combine the validated systems

Begin with a static agentic bank baseline, then unlock capabilities already
validated in phase b.

- **d0:** static agentic bank baseline.
- **d1:** prompt evolution.
- **d2:** rules and configuration evolution.
- **d3:** workflow and runtime code evolution.
- **d4:** predictive models.
- **d5:** agent creation and deletion.
- **d6:** organizational topology evolution.
- **d7:** heterogeneous evolution.
- **d8:** self-managed improvement loop.
- **d9:** frozen final evaluation on unseen and out-of-distribution bank worlds.

**Gate:** each unlock requires a completed evidence pack and explicit approval.
The final claim is evaluated against scenarios excluded from all development
and model selection.

## world versions and experiment versions

Bank world versions and evolutionary experiment versions are tracked
independently. A change to the world should not silently change an experiment's
benchmark, and an experiment should be rerunnable against a pinned world
version. Every run records both identifiers when applicable.
