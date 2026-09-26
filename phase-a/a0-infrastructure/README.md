# a0: evaluation infrastructure

## purpose

Establish a reproducible baseline and the logging needed to interpret later
experiments. a0 does not evolve any model or harness component.

## frozen benchmark and model

Use the public IFEval benchmark as the a0 task set. It contains 541
instruction-following prompts with programmatic verifiers and is listed under
the Apache 2.0 license. The benchmark comparison, split safeguards, and source
links are in [`../../../docs/benchmark_selection.md`](../../../docs/benchmark_selection.md).

Use the cached `Qwen/Qwen3-0.6B` checkpoint as the frozen evaluated model. The
cache contains revision `c1899de289a04d12100db370d81485cdf75e47ca`. A local
smoke inference completed successfully with Transformers 4.57.6. The isolated
A0 environment currently reports MPS unavailable, so the baseline runs on CPU.
The run records the actual device and full environment manifest.

## pinned data and split plan

The source data is pinned to Hugging Face dataset revision
`966cd89545d6b6acfd7638bc708b98261ca58e84`. The downloaded
`ifeval_input_data.jsonl` has 541 rows, 25 instruction types, no duplicate
example keys, and SHA-256
`6a85310ca8ce15eff755aa08a3a4ff931c7e273e7515ebb3c492ea85fd8288f2`.
The local source copy lives under the ignored `runs/a0/source/ifeval/` path.
The official Google Research verifier is pinned to repository commit
`d36068b845da4c2b24927fee2cea1e6ef98dadda` and is checked out under ignored
`runs/a0/source/google-research/instruction_following_eval/`. Its declared
runtime dependencies are `absl`, `langdetect`, `nltk`, and `immutabledict`.

The project split uses a deterministic iterative multilabel assignment from
example keys and instruction types, with 60% evolution, 20% validation, and
20% held-out test. The generated manifest records seed, exact membership, split
fingerprints, and per-type counts. The current counts are 325 evolution, 108
validation, and 108 held-out examples. All 25 instruction types appear in each
split, with at least two examples per type in validation and held-out. Never
supply validation or held-out prompt text or labels to the improver. Keep
held-out outputs outside the public repository until the final evaluation is
complete.

## baseline protocol

- Use the official Google Research IFEval verifier at the commit above, with
  its original strict and loose prompt-level and instruction-level scores.
- Freeze decoding to greedy generation with temperature disabled, no sampling,
  and a recorded maximum new-token count. Store the exact initial system
  instruction and prompt-rendering template.
- Record model and tokenizer revisions, Transformers and PyTorch versions,
  device, hardware, generation settings, elapsed time, and token counts where
  available for every example.
- Save raw model outputs, verifier results, per-example metrics, aggregate
  metrics, configuration, source fingerprints, and an environment manifest in
  ignored `runs/` storage. Publish only small manifests and documentation.
- Use JSONL and JSON manifests as the canonical local record. MLflow remains
  optional until its dependency and storage setup are pinned; it must not be a
  hidden prerequisite for reproducing the baseline.

## implementation

Install the isolated dependencies from this directory's `requirements.txt`,
then start the console from the repository root:

```bash
.venv/bin/python phase-a/a0-infrastructure/dashboard.py
```

Open `http://127.0.0.1:8765`. The console provides:

- an overview with live health, ETA, phase progress, protocol warnings, and the
  A0 evidence gate;
- a searchable run registry and detailed run pages;
- official strict and loose metric histories;
- 95% Wilson intervals for prompt-level pass rates;
- per-example prompts, responses, instruction checks, tokens, and latency for
  evolution and validation data;
- instruction-family slice analysis and run-to-run comparison;
- durable start, resume, and stop controls with process logs;
- exact model, data, evaluator, code, environment, artifact, and MLflow
  provenance;
- a gate decision surface that cannot approve A0 until its evidence checks
  pass.

The held-out example browser is deliberately disabled so final task text is not
exposed during development. Aggregate held-out results may be recorded only at
the registered final evaluation point.

The checked-in `config.json` pins the dataset, verifier, local model snapshot,
greedy decoding settings, split seed, and proportions. Each invocation creates
or resumes a local directory under `runs/a0/experiments/`. JSON and JSONL files
remain the canonical, directly auditable evidence. The runner also mirrors
parameters, metric history, tags, and evidence artifacts into a local MLflow
SQLite ledger at `runs/a0/mlflow.db`.

To open the standard MLflow interface alongside the RRSI console:

```bash
.venv/bin/mlflow server \
  --backend-store-uri sqlite:///runs/a0/mlflow.db \
  --port 5000
```

Then open `http://127.0.0.1:5000`. W&B is not required for A0 because MLflow
provides local run search, comparison, metric history, and artifact tracking
without transmitting experiment data to a hosted service.

## completion evidence

Provide a run manifest, dataset and evaluator fingerprints, frozen baseline
outputs, per-example and aggregate metrics, cost and latency data, reproduction
instructions, attribution notice, and a decision record. a0 is complete only
when the baseline can be reproduced and the owner approves the evidence.
