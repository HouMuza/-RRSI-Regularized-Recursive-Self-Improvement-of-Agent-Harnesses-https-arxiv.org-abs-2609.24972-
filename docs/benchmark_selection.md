# benchmark selection

## decision for a0

Use Google's Instruction-Following Evaluation dataset, IFEval, as the primary
benchmark for a0 and the prompt-only phase-a experiments. It contains
541 prompts with verifiable instruction constraints and is distributed under
Apache 2.0. The task checks include constraints such as word counts, required
keywords, punctuation, and output format. The official evaluator applies
programmatic checks to responses.

The benchmark is a closer first fit than a custom task set because it is
established, directly tests instruction following, and uses automatic checks.
It also avoids writing and validating an evaluator before we have any
experimental baseline.

Sources:

- [IFEval dataset card and license](https://huggingface.co/datasets/google/IFEval)
- [IFEval evaluation code](https://github.com/google-research/google-research/tree/master/instruction_following_eval)
- [IFEval paper](https://arxiv.org/abs/2311.07911)
- [Qwen3-0.6B model card and license](https://huggingface.co/Qwen/Qwen3-0.6B)

The project will retain dataset attribution and the Apache 2.0 license notice
with its data manifest. No dataset fee is listed by the source. We must still
follow the license terms and cite the dataset and paper.

## comparison considered

| Dataset | Published size | Scoring | License | Fit for the first experiment |
| --- | ---: | --- | --- | --- |
| IFEval | 541 prompts | Programmatic checks for verifiable instruction constraints | Apache 2.0 | Recommended. Direct fit for prompt evolution and avoids executing generated code. |
| GSM8K | 8,500 math word problems | Extract the final numeric answer and compare | MIT | Good alternative for reasoning, but narrower than instruction following. |
| MBPP | 974 Python problems | Run supplied tests against generated code | CC BY 4.0 | Good for a later coding and tool-use experiment, but safely executing generated code adds setup and security work to a0. |

GSM8K's official repository describes 7.5K training examples and 1K test
examples, each with multi-step arithmetic solutions. MBPP's official Google
Research dataset card lists 974 rows and CC BY 4.0. These are viable free-to-use
alternatives with different attribution and adaptation requirements.

Sources:

- [GSM8K dataset description](https://github.com/openai/grade-school-math)
- [GSM8K MIT license](https://github.com/openai/grade-school-math/blob/master/LICENSE)
- [MBPP dataset card](https://huggingface.co/datasets/google-research-datasets/mbpp)
- [Google Research dataset licensing statement](https://github.com/google-research/google-research)

## limits and safeguards

- The IFEval dataset card provides one 541-row split, not official evolution,
  validation, and test splits. Our split assignment must be described as a
  project-created split, pinned, and recorded with row IDs and fingerprints.
- IFEval is public and predates our run. We cannot claim its prompts were absent
  from the evaluated model's training data. Treat possible benchmark exposure
  as a limitation, keep the improver away from the final split, and avoid
  describing the result as an uncontaminated out-of-distribution test.
- Stratify split assignment by the benchmark's verifiable instruction types
  where possible. Record each prompt's instruction types in the split manifest
  so the score can be analyzed by task family.
- Use the official IFEval verifier at a pinned source revision if its runtime
  requirements are compatible. Record the evaluator revision and dependencies.
  Any changes to verifier behavior require a new evaluator version and explicit
  documentation.
- Freeze the dataset revision, split seed, split memberships, initial system
  prompt, model revision, decoding settings, and metric definitions before
  collecting baseline results.

## split roles to pre-register

The registered split roles are:

- **evolution:** the improver may use these tasks and their allowed feedback.
- **validation:** used at pre-registered checkpoints for diagnostics and
  selection under a fixed rule. Do not provide validation task content or
  labels to the improver.
- **held-out test:** reserved for the final planned transfer evaluation. Do
  not use its results to revise prompts, selection rules, or the protocol.

The pinned download contains 541 examples, 25 distinct instruction types, and
no duplicate example keys. The a0 protocol uses deterministic 60/20/20
evolution, validation, and held-out test splits. Since prompts can combine several instruction types,
assignment uses a deterministic iterative multilabel method. The generated
splits contain 325 evolution examples, 108 validation examples, and 108
held-out examples, with all 25 instruction types in each split. The minimum
per-type count is two in validation and held-out. Exact membership and
per-type counts are recorded in the ignored local run manifest. Keep the final
test data and outputs outside the public repository
while they are being used as held-out evaluation material. Publish hashes and
the split procedure in the run manifest.

The dataset is pinned to revision
`966cd89545d6b6acfd7638bc708b98261ca58e84`. The SHA-256 of the source
`ifeval_input_data.jsonl` is
`6a85310ca8ce15eff755aa08a3a4ff931c7e273e7515ebb3c492ea85fd8288f2`.
The official verifier is pinned to Google Research commit
`d36068b845da4c2b24927fee2cea1e6ef98dadda`; its declared dependencies are
`absl`, `langdetect`, `nltk`, and `immutabledict`.
