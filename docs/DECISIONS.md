# decision log

Record research and implementation decisions that affect comparability or
future interpretation. Add new entries at the top.

## 2026-09-26: use the rrsi paper as a reference, not as an assumed result

- **Source:** Xia et al., [rrsi: Regularized Recursive Self-Improvement of
  Agent Harnesses](https://arxiv.org/abs/2609.24972), version 2.
- **Decision:** Treat a1 as a scoped prompt-only baseline experiment, not a full
  reproduction. Use a separate final held-out test set that is inaccessible to
  candidate selection. a3 will pre-register any adapted proposal and selection
  controls.
- **Reason:** The paper's harness edit space includes multiple components and
  its selection process uses evolution-set measurements with regularizers,
  while held-out tasks measure transfer.
- **Evidence summary:** See [`paper_rrsi.md`](paper_rrsi.md). The paper is a
  preprint and its reported results are not our experimental findings.
- **Decision owner:** Project owner.

## 2026-09-26: stage the work as separate phases

- **Decision:** Use separate folders for phases A through D, with common
  evaluation and logging infrastructure in `shared/`.
- **Reason:** Keep the rsi proof-of-machinery, heterogeneous evolution, bank
  world, and combined application independently inspectable.
- **Constraint:** Later phase folders are organizational scaffolding only.
  They remain locked until the preceding evidence gate is explicitly approved.
- **Decision owner:** Project owner.

## 2026-09-26: begin with a0, then prompt-only a1

- **Decision:** The first experiments establish repeatability and then allow
  only system prompt changes.
- **Reason:** Isolate whether the improvement and selection loop works before
  adding additional mutation types.
- **Constraint:** Model, evaluator, data, tools, and runtime are held fixed in
  a1. Their exact choices are to be recorded during a0.
- **Decision owner:** Project owner.
