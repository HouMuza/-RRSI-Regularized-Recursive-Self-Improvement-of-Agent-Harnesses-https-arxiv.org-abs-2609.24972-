# a1 final result

## status

A1 completed its deterministic control and DeepSeek proposer runs. The
improvement hypothesis was not supported, so the A1 improvement gate did not
pass.

## primary result

Neither proposal strategy produced a candidate that exceeded its current
parent on the paired 96 example confirmation panel.

| proposer | generation 1 | generation 2 | generation 3 | accepted changes |
| --- | ---: | ---: | ---: | ---: |
| deterministic | -1.0 pp | -1.0 pp | -1.0 pp | 0 |
| deepseek | -6.3 pp | -5.2 pp | -9.4 pp | 0 |

The values are the strongest finalist's strict prompt accuracy difference from
its parent. Negative values indicate regression.

## final evaluations

Both runs retained the approved A0 system prompt. Evolution, validation, and
heldout comparisons therefore evaluated the same prompt on both sides and
reported 0.0 percentage point differences. These equalities confirm baseline
reproduction. They do not demonstrate an evolved improvement.

## interpretation

The selection machinery protected the baseline from twelve deterministic and
twelve DeepSeek proposed changes across the two runs. The result establishes
that proposal, evaluation, rejection, lineage, resumption, and final reporting
worked. It does not establish that prompt evolution is generally ineffective
or that DeepSeek cannot propose a useful prompt under another registered
starting condition.

The concise A0 prompt may provide limited improvement headroom. A1b will test
this explanation with starting prompts of different registered quality and
conflict levels.

## gate decision

```text
Experiment: a1 prompt evolution
Evidence pack location and revision: runs/a1/experiments and this report
Primary result: no accepted prompt change in either registered run
Heldout result: 0.0 pp because the original prompt remained the winner
Cost and complexity change: no deployed prompt complexity change
Known failures and limitations: one run per strategy and one strong baseline
Protocol deviations: none identified
Decision: revise
Approver and date: project owner, 2026-09-28
Rationale: preserve A1 as a valid negative result and run preregistered baseline sensitivity before a2
```
