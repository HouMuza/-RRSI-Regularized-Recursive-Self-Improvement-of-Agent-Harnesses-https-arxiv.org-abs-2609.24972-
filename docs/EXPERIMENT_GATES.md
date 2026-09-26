# Experiment Gates and Evidence Requirements

The project advances one experiment at a time. Completing code or obtaining a
promising score does not unlock the next experiment. The project owner reviews
the evidence pack and explicitly approves each gate.

## Required evidence pack

Every experiment produces a versioned, immutable evidence pack containing:

1. **Question and hypotheses.** State the question, expected outcomes, and what
   results would contradict the hypothesis.
2. **Run manifest.** Record run ID, timestamp, source revision, phase and
   experiment IDs, random seeds, environment, hardware, model names and exact
   versions, decoding settings, and all relevant configuration.
3. **Data provenance.** Record source, license or access terms, preprocessing,
   split assignments, and cryptographic fingerprints for every dataset file.
4. **Evaluator provenance.** Record evaluator code revision, rubric or scoring
   version, and any known evaluator limitations.
5. **Mutation ledger.** Keep each candidate's parent ID, complete proposed
   diff, rationale, status, failure details, evaluation IDs, selection result,
   and complexity delta. Rejected candidates are part of the result.
6. **Raw outcomes.** Store per-example inputs or stable references, outputs,
   scores, errors, retries, and timing. Protect secrets and personal data.
7. **Aggregate metrics.** Report split-level and task-family results, sample
   counts, uncertainty estimates, cost, latency, token use, and complexity.
8. **Reproduction instructions.** Describe how to reproduce the run from the
   pinned artifacts without depending on unrecorded state.
9. **Analysis and deviations.** Explain exclusions, missing data, protocol
   deviations, and alternative interpretations.
10. **Decision record.** Record the gate decision, approver, date, and rationale.

## Split discipline

- The **evolution split** may be used to propose and optimize candidates.
- The **validation split** may be used only according to the pre-registered
  candidate selection rule.
- The **held-out test split** stays inaccessible to the improver and to
  candidate selection. Use it only for the planned final transfer evaluation.
- Any use of held-out results to make another change invalidates that split for
  subsequent confirmatory claims. Document and replace it with a newly sealed
  split before continuing.

The RRSI paper describes conservative candidate acceptance using repeated
measurements on its evolution split, with separate held-out suites used to
measure transfer. Do not describe this as selecting candidates on the held-out
test set. If our protocol adds validation-based selection, document that as our
own pre-registered design choice.

## Metrics

Choose metrics before a run. Report at minimum:

- primary task score and per-task-family scores;
- pass rate, failure rate, and safety or constraint violations where relevant;
- candidate count, accepted count, and rejection reasons;
- prompt or system complexity measures appropriate to the experiment;
- inference tokens, wall-clock latency, and monetary or compute cost;
- uncertainty intervals and paired comparisons where the design permits them.

Do not combine these into one score unless the weights and rationale were
specified before observing outcomes. If using a complexity-regularized score,
report its components separately as well.

## Gate decision template

Each experiment should add a decision record with:

```text
Experiment:
Evidence pack location and revision:
Primary result:
Held-out result, if applicable:
Cost and complexity change:
Known failures and limitations:
Protocol deviations:
Decision: approve / revise / stop
Approver and date:
Rationale:
```

## Data and secrets

Do not commit API keys, credentials, private data, or restricted benchmark
content. Store large or restricted artifacts in an approved location and commit
their identifiers and cryptographic fingerprints. Keep raw logs access
controlled when they contain sensitive inputs or outputs.
