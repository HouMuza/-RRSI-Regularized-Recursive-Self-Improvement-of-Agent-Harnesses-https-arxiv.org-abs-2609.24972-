# regularized recursive self-improvement experiments

This repository is a staged research workspace for testing whether recursive
self-improvement can improve an agent harness while still generalizing to
unseen tasks. The work begins with a small prompt-only experiment and expands
only after the current experiment has a complete evidence pack and the project
owner approves its gate.

## research sequence

| Track | Purpose | Current state |
| --- | --- | --- |
| phase a | Establish and study recursive self-improvement | a1 ready |
| phase b | Test evolution of rules, code, models, and agent structures | Locked |
| phase c | Build a simulated bank as a separate world model | Locked |
| phase d | Combine the validated evolutionary system with the bank | Locked |

The detailed phase map is in [`docs/RESEARCH_PLAN.md`](docs/RESEARCH_PLAN.md).
The gate and evidence requirements are in [`docs/EXPERIMENT_GATES.md`](docs/EXPERIMENT_GATES.md).
The referenced paper and its implications for our design are summarized in
[`docs/paper_rrsi.md`](docs/paper_rrsi.md).

## repository layout

```text
shared/                 Reusable evaluation, model adapters, and logging
phase-a/                rsi machinery experiments
phase-b/                Heterogeneous software evolution experiments
phase-c/                Simulated bank world, developed independently
phase-d/                Evolutionary system applied to the bank
docs/                   Research plan, gate policy, and decision records
```

Each phase is a separate folder. Shared infrastructure lives outside those
folders so experiments can reuse it without copying implementation. A phase
folder does not mean that phase is authorized to start. Later phases remain
locked until their documented gate is approved.

## initial scope

The first work is a0, the evaluation infrastructure, followed by a1, prompt
evolution. a1 changes only the evaluated agent's system prompt. Model weights,
tools, datasets, evaluator, and runtime remain fixed for that experiment. The
exact model identifiers, benchmark, split construction, and API configuration
must be recorded before collecting results.

No model API calls or paid runs are made by setting up this repository. The
first experiment will begin only after its configuration and baseline protocol
are reviewable.

## getting started

This scaffold intentionally does not install dependencies. Choose and record
the environment and model access method during a0, then add pinned dependencies
and setup instructions alongside the implementation. Keep credentials outside
the repository and load them from environment variables or a local ignored
configuration file.

## research integrity

- Freeze evaluation data, scoring rules, and model versions before a run.
- Keep evolution, validation, and held-out test data separate.
- Record every proposed mutation, including rejected and failed proposals.
- Preserve raw per-example outputs and aggregate metrics.
- Never tune against held-out test results.
- Record all deviations and make results reproducible from a run manifest.
- Do not advance through a gate without explicit project-owner approval.

See [`docs/EXPERIMENT_GATES.md`](docs/EXPERIMENT_GATES.md) for the complete
requirements.
