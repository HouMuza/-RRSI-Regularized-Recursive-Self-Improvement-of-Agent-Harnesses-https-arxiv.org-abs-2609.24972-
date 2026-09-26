# Phase A: Prove the RSI Machinery

Phase A tests whether recursive improvement, evaluation, selection, and
lineage work in a small task environment.

Experiments are ordered and gated:

1. `a0-infrastructure`: reproducible evaluation and logging.
2. `a1-prompt-evolution`: only the evaluated model's system prompt may change.
3. `a2-overfitting`: measure transfer from evolution tasks to unseen tasks.
4. `a3-regularized-rsi`: add regularization and compare with the naive process.

Do not start a later experiment until its predecessor has a complete evidence
pack and explicit approval. See [`../docs/EXPERIMENT_GATES.md`](../docs/EXPERIMENT_GATES.md).
