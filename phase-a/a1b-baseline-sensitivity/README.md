# a1b: baseline sensitivity

A1b tests whether prompt evolution depends on the quality and conflict level of
the starting system prompt. It preserves A1 unchanged and uses the same frozen
model, data, evaluator, search budget, and selection rule.

The exact conditions are in [`baselines.json`](baselines.json). The hypotheses
and comparison policy are frozen in
[`preregistration.md`](preregistration.md).

Each new run must record both:

- a baseline condition id
- a proposal strategy, either `deterministic` or `deepseek`

A run cannot resume with a different condition or proposal strategy. Custom
condition baselines generate their own responses and must never reuse A0
responses produced with another system prompt.

## running a registered condition

Use the A1 dashboard and choose both a starting prompt and proposal strategy.
The equivalent command is:

```bash
.venv/bin/python phase-a/a1-prompt-evolution/run_a1.py \
  --experiment a1b \
  --baseline-id ordinary \
  --proposer deterministic \
  --stage search
```

Use the same run id, experiment, baseline id, and proposer when resuming
validation or heldout evaluation. The runner verifies these immutable values
against the manifest.
