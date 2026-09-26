# paper notes: rrsi

## citation and version

Peng Xia et al., [rrsi: Regularized Recursive Self-Improvement of Agent
Harnesses](https://arxiv.org/abs/2609.24972), arXiv:2609.24972, version 2,
revised 23 September 2026. This is a preprint. These notes summarize the
authors' method and reported results. They are not an independent reproduction.

Primary sources:

- [Abstract and version history](https://arxiv.org/abs/2609.24972)
- [Full paper, version 2](https://arxiv.org/html/2609.24972v2)
- [Authors' code repository](https://github.com/google-research/rrsi)
- [Project page](https://regularized-rsi.com/)

## research question

The paper studies whether repeated edits to an agent harness can overfit a
finite set of evolution tasks. A harness includes more than a prompt. It may
include control flow, tools, memory, context management, skills, and subagents.
The backbone policy remains frozen while the harness evolves.

The central design choice is to leave the set of potentially editable harness
components open while regularizing the search trajectory and the rules that
allow a candidate to replace the incumbent. rrsi does not prescribe one target
architecture. It constrains how quickly and on what evidence the system
changes.

## method in the paper

rrsi has proposal-side and selection-side controls.

### proposal-side controls

1. **Annealed edit budget.** A candidate may bundle only a limited number of
   independently attributable edits. The limit decreases over the run. Early
   rounds can explore coordinated changes, while later rounds use smaller
   changes that are easier to attribute.
2. **Evidence-aware history.** Each evaluated edit is logged with its
   component, hypothesis, source diff, score and cost changes, and whether it
   was accepted. The proposer receives this history so rejected ideas remain
   negative evidence instead of being proposed repeatedly.
3. **Structured exploration.** If progress stalls within an empirically
   measured noise band, some proposal capacity is directed toward editable
   components that have not yet been explored.

### selection-side controls

1. **Leakage screening.** A critic screens candidate diffs before full
   evaluation for benchmark-specific task names, entities, values, answers,
   and inert machinery. The screen targets leakage, not particular component
   types.
2. **Noise-aware stability floor.** Repeated base-harness evaluations estimate
   a noise tolerance. An accepted candidate cannot fall below the best observed
   evolution score by more than that tolerance. This limits accumulated small
   regressions.
3. **Gain-dependent cost rule.** When measured score gain exceeds the noise
   band, allowable relative cost growth depends on the gain. The reported cost
   proxy is policy-token use.
4. **Structural pruning.** Components with no positive measured gain over a
   recent window are sent to the proposer as deletion targets.
5. **Domain-specific guards.** The method permits non-compensatory safeguards
   appropriate to a domain.

The authors use analogies to L0, L1, and L2 regularization for edit sparsity,
structural pruning, and aggregate cost control. These are functional analogies,
not direct optimization of L0, L1, or L2 penalties on a fixed parameter vector.

## evaluation design and reported results

The paper reports eight benchmarks in three domains: coding, agentic workspace,
and engineering design. The evaluated policy is frozen during each evolution
run. The system evolves on one suite in a domain, then the resulting harness is
run unchanged on in-distribution held-out tasks and separate out-of-distribution
benchmarks.

The version 2 abstract reports up to 14.1 points of gain on an evolution split,
up to 4.7 points on the five out-of-distribution benchmarks, and about 30%
fewer policy tokens than unregularized evolution. The detailed workspace
ablation reports:

| Variant | Evolution score | In-distribution held-out | ood average | Policy tokens per trial |
| --- | ---: | ---: | ---: | ---: |
| Unevolved baseline | 89.4 | 86.9 | 39.7 | 1.56 million |
| Unregularized evolution | 92.8 | 88.9 | 40.3 | 3.80 million |
| rrsi without proposal controls | 90.7 | 88.8 | 41.9 | 2.69 million |
| rrsi without acceptance controls | 91.5 | 88.7 | 41.0 | 3.59 million |
| rrsi | 90.5 | 89.2 | 43.6 | 2.42 million |

The ood average in this table is the mean across JobBench, GDPval, and
APEX-Agents. These are the paper's measurements, not results from our project.
In this ablation, unregularized evolution has the highest evolution score but
transfers less well and costs more. Removing either family of regularizers
reduces the reported ood average. The paper also reports positive held-out
results in its other domains and tests transfer to a backbone model that was
not used during search.

The LinkedIn post's phrase “improved on every one” should be read in the
context of the paper's tested held-out splits and comparisons. It does not
guarantee improvement on every unseen task or in a new project.

## how this informs our plan

The first prompt-only experiment is a deliberately narrow systems check. It
does not reproduce the whole paper, since the paper's harness can include
control flow, configuration, tools, skills, memory, context management, and
subagents. We should label a1 a prompt-only baseline experiment, not a full rrsi
replication.

| Our experiment | Relationship to the paper |
| --- | --- |
| a0: infrastructure | Establishes repeatability, frozen model and evaluator versions, run lineage, cost capture, and separate data splits. |
| a1: prompt evolution | Tests the proposal, evaluation, and selection loop with one mutable component. It is a scoped initial experiment. |
| a2: overfitting | Measures whether repeated adaptation to a finite evolution set produces a transfer gap in our environment. |
| a3: regularized rsi | Implements and ablates selected proposal and selection controls. The exact subset and deviations must be declared before runs. |
| B: broader software evolution | Explores additional mutation classes after the basic loop is understood. This extends beyond the initial prompt-only study. |

rrsi's held-out benchmarks are final transfer evaluations, not a pool from
which the proposer selects candidates. We may use a separate validation split
for a pre-registered selection rule, but the final held-out test split must
remain unseen by the improver and selection process. Using held-out results to
guide a new edit makes that split development data and invalidates it for later
confirmatory claims.

## decisions and open questions for a0 and a3

- Which task family gives us a small, licensed, repeatable starting benchmark?
- Can we use a deterministic verifier, or must a task rely on a judge model?
- How will repeated baseline runs estimate evaluation noise?
- What constitutes an atomic, attributable prompt edit in a1?
- Which costs will we track beyond policy tokens, such as improver tokens,
  wall-clock latency, retries, and monetary or local compute cost?
- Which proposal-side and selection-side regularizers can be implemented
  faithfully at our scale, and which adaptations must be reported?
- How will leakage screening be evaluated, given that a critic can miss leakage
  or reject a useful general mechanism?
- What sample size, number of seeds, and uncertainty procedure are affordable
  while still supporting a meaningful comparison?
- Are the paper's benchmark artifacts and evaluation environments available
  under terms that permit a reproduction? Do not assume access to the paper
  implies access to its datasets or infrastructure.

These decisions belong in a0's configuration and preregistered protocol. Avoid
choosing parameters after looking at final held-out results.

## interpretation limits

- The cited work is a preprint, and our project has not reproduced its
  measurements.
- Results depend on the tested harnesses, policies, tasks, evaluators, budget,
  and benchmark access available to the authors.
- A score increase on a finite set does not establish broad generalization by
  itself. Transfer claims depend on the held-out set and its distance from the
  evolution distribution.
- Judge-mediated tasks can introduce evaluator-specific effects. The paper
  includes simulator or testbench-graded engineering tasks, which helps test
  transfer under deterministic evaluation but does not remove every confound.
- The regularization analogies are conceptual. Any replication claims must
  describe the actual rules and measurements we use.
- The paper reports policy-token cost as an important efficiency measure. Our
  project should also account for proposer calls and total experiment cost so
  cheaper evaluated harnesses do not hide expensive search.
