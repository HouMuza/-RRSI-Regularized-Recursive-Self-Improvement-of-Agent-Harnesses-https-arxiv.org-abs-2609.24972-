# Shared Infrastructure

Code placed here may be reused by multiple experiments. Keep experiment
specific assumptions in the experiment directory and pass them through explicit
configuration. Shared components should expose versioned interfaces so a
change cannot silently alter the meaning of an earlier run.

Planned components include dataset manifests and split validation, model
adapters, evaluators, mutation and lineage records, run manifests, metrics,
artifact storage, and experiment tracking. A0 will define these interfaces
before implementation begins.
