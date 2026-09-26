# Regularized Recursive Self-Improvement Experiments

This repository is a staged research workspace for testing whether recursive
self-improvement can improve an agent harness while still generalizing to
unseen tasks. The work begins with a small prompt-only experiment and expands
only after the current experiment has a complete evidence pack and the project
owner approves its gate.

## Research sequence

| Track | Purpose | Current state |
| --- | --- | --- |
| Phase A | Establish and study recursive self-improvement | A0 setup |
| Phase B | Test evolution of rules, code, models, and agent structures | Locked |
| Phase C | Build a simulated bank as a separate world model | Locked |
| Phase D | Combine the validated evolutionary system with the bank | Locked |

The detailed phase map is in [`docs/RESEARCH_PLAN.md`](docs/RESEARCH_PLAN.md).
The gate and evidence requirements are in [`docs/EXPERIMENT_GATES.md`](docs/EXPERIMENT_GATES.md).
The referenced paper and its implications for our design are summarized in
[`docs/PAPER_RRSI.md`](docs/PAPER_RRSI.md).

## Repository layout

```text
shared/                 Reusable evaluation, model adapters, and logging
phase-a/                RSI machinery experiments
phase-b/                Heterogeneous software evolution experiments
phase-c/                Simulated bank world, developed independently
phase-d/                Evolutionary system applied to the bank
docs/                   Research plan, gate policy, and decision records
```

Each phase is a separate folder. Shared infrastructure lives outside those
folders so experiments can reuse it without copying implementation. A phase
folder does not mean that phase is authorized to start. Later phases remain
locked until their documented gate is approved.

## Initial scope

The first work is A0, the evaluation infrastructure, followed by A1, prompt
evolution. A1 changes only the evaluated agent's system prompt. Model weights,
tools, datasets, evaluator, and runtime remain fixed for that experiment. The
exact model identifiers, benchmark, split construction, and API configuration
must be recorded before collecting results.

No model API calls or paid runs are made by setting up this repository. The
first experiment will begin only after its configuration and baseline protocol
are reviewable.

## Getting started

This scaffold intentionally does not install dependencies. Choose and record
the environment and model access method during A0, then add pinned dependencies
and setup instructions alongside the implementation. Keep credentials outside
the repository and load them from environment variables or a local ignored
configuration file.

## Research integrity

- Freeze evaluation data, scoring rules, and model versions before a run.
- Keep evolution, validation, and held-out test data separate.
- Record every proposed mutation, including rejected and failed proposals.
- Preserve raw per-example outputs and aggregate metrics.
- Never tune against held-out test results.
- Record all deviations and make results reproducible from a run manifest.
- Do not advance through a gate without explicit project-owner approval.

See [`docs/EXPERIMENT_GATES.md`](docs/EXPERIMENT_GATES.md) for the complete
requirements.
