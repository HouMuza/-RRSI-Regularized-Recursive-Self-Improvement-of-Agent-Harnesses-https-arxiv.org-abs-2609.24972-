# a1: prompt evolution

## purpose

Test whether automated mutation and selection can improve a frozen model by
changing only its system prompt.

## locked variables

The evaluated model and weights, tools, runtime, task data, evaluator, and
selection protocol are fixed. Only the system prompt is mutable. The improver
may inspect only the information allowed by the pre-registered protocol.

## start condition

a0 is complete, its evidence pack is reproducible, and the project owner
approved the a0 gate on 2026-09-27. The frozen protocol is recorded in
[`preregistration.md`](preregistration.md) and [`config.json`](config.json).

The first active run uses the deterministic mutation bank as a control. The
DeepSeek-driven variant is separately registered in
[`deepseek_preregistration.md`](deepseek_preregistration.md) with provider
settings in [`deepseek_config.json`](deepseek_config.json).

## execution stages

1. `search` runs three recursive generations on nested evolution panels and
   evaluates the selected incumbent on the complete evolution split.
2. `validation` evaluates the frozen winner without changing selection.
3. `heldout_test` performs the final transfer measurement.

The runner writes ignored evidence under `runs/a1/experiments/`. Checked-in
source and documentation never contain generated benchmark responses.

## required outputs

Keep the initial prompt, every proposed prompt and rationale, parent and child
lineage, evaluation outcomes, selection decisions, failed candidates, cost,
and final held-out results. Include a frozen baseline comparison and uncertainty
estimates.

## running a1

Use the `a1 evolution` page in the local experiment console. The button follows
the registered sequence and resumes the latest unfinished run:

1. `start search`
2. `start validation`
3. `start heldout test`

The equivalent commands are:

```bash
.venv/bin/python phase-a/a1-prompt-evolution/run_a1.py \
  --run-id a1-YYYYMMDD-HHMMSS --stage search
.venv/bin/python phase-a/a1-prompt-evolution/run_a1.py \
  --run-id a1-YYYYMMDD-HHMMSS --stage validation
.venv/bin/python phase-a/a1-prompt-evolution/run_a1.py \
  --run-id a1-YYYYMMDD-HHMMSS --stage heldout_test
```

For a new DeepSeek proposer run, set the key only in the local process
environment and give the run a new id:

```bash
export DEEPSEEK_API_KEY="your-local-key"
.venv/bin/python phase-a/a1-prompt-evolution/run_a1.py \
  --run-id a1-YYYYMMDD-HHMMSS --stage search --proposer deepseek
```

The dashboard must be started from a shell that has the same environment
variable if its run button will launch DeepSeek. The dashboard reports whether
the key is configured, but never returns or displays its value.

Do not create a new run id between stages. Search can be interrupted and
resumed because complete response records, candidate definitions, generation
decisions, and metrics are durable.

## evidence layout

```text
runs/a1/experiments/<run-id>/
  manifest.json
  mlflow.json
  search_state.json
  proposals/g01-deepseek.json
  candidates/<candidate-id>/candidate.json
  candidates/<candidate-id>/evaluations/<stage>/
  generations/g01.json
  comparisons/evolution.json
  comparisons/validation.json
  comparisons/heldout_test.json
```

The comparison records report paired score differences and deterministic
bootstrap intervals. MLflow mirrors searchable parameters, stage metrics, and
the evidence tree. JSON and JSONL files remain canonical.
