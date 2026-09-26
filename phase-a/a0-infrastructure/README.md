# A0: Evaluation Infrastructure

## Purpose

Establish a reproducible baseline and the logging needed to interpret later
experiments. A0 does not evolve any model or harness component.

## To decide before implementation

- non-banking task benchmark and its license or access terms;
- evolution, validation, and held-out split construction;
- frozen evaluated model and inference method;
- improver model and inference method, without making improvement calls yet;
- evaluator, primary metrics, and uncertainty method;
- artifact retention, experiment tracking, and cost measurement;
- random seeds and repeatability protocol.

## Completion evidence

Provide a run manifest, dataset and evaluator fingerprints, frozen baseline
outputs, per-example and aggregate metrics, cost and latency data, reproduction
instructions, and a decision record. A0 is complete only when the baseline can
be reproduced and the owner approves the evidence.
