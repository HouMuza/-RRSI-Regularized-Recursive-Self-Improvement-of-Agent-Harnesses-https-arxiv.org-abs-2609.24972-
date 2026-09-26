# a0: evaluation infrastructure

## purpose

Establish a reproducible baseline and the logging needed to interpret later
experiments. a0 does not evolve any model or harness component.

## to decide before implementation

- non-banking task benchmark and its license or access terms;
- evolution, validation, and held-out split construction;
- frozen evaluated model and inference method;
- improver model and inference method, without making improvement calls yet;
- evaluator, primary metrics, and uncertainty method;
- artifact retention, experiment tracking, and cost measurement;
- random seeds and repeatability protocol.

## completion evidence

Provide a run manifest, dataset and evaluator fingerprints, frozen baseline
outputs, per-example and aggregate metrics, cost and latency data, reproduction
instructions, and a decision record. a0 is complete only when the baseline can
be reproduced and the owner approves the evidence.
