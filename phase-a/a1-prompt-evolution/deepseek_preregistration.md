# a1 deepseek proposer preregistration

## role separation

DeepSeek is the improver. It receives the current system prompt, aggregate
evolution metrics, selected evolution failures, selected response traces, and
the prior mutation ledger. It proposes complete replacement system prompts
with hypotheses and targeted failure modes.

DeepSeek is not the acceptance evaluator. The pinned official IFEval verifier
produces strict and loose instruction-following outcomes. The existing paired
screening and confirmation rule decides which candidate, if any, is inherited.

## provider configuration

The provider configuration is stored in `deepseek_config.json`. The API key is
read only from `DEEPSEEK_API_KEY`. The key must never be stored in a run
artifact, MLflow, a log, source control, or a dashboard response.

Every proposer call records the requested and returned model identifiers,
system fingerprint when supplied by the provider, request id, latency, token
usage, evidence supplied to the proposer, parsed proposal, and request hash.

## evidence boundary

Only evolution-set prompts, responses, verifier outcomes, and mutation history
may be supplied to DeepSeek. Validation and held-out prompt text, responses,
per-example outcomes, and aggregate outcomes cannot influence a proposal.

## candidate contract

Each generation requests four distinct children of the current incumbent.
Each proposal must include a complete system prompt, hypothesis, diagnosis,
target failure modes, and expected effect. Candidate prompts cannot add more
than the registered word budget. Invalid, duplicate, unchanged, or over-budget
proposals stop the run before candidate evaluation.

## comparison

The existing deterministic mutation run remains a control. A DeepSeek run uses
a new run id and records `deepseek` as its proposer. Results from the two
proposal mechanisms are reported separately under the same frozen model,
dataset, evaluator, panels, and acceptance rule.
