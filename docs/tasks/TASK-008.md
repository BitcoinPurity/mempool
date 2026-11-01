# TASK-008: GitHub-hosted CI

REQ-008. PR #3 targets main. Status: implementation and local verification; remote verification pending.

## Assessment

The fork retained the upstream mempool-ci self-hosted runner label, but has no registered runners. Its push triggers target master rather than main. Actions is enabled and PR #3 is mergeable, but no runs existed for its initial commit; runner absence alone does not explain the missing run records.

## Changes

- Move executable workflows to ubuntu-24.04, listen to main pushes and opened/synchronize/reopened/ready_for_review PR events. Keep release/tag-only and manual workflows at their existing event scopes. Do not use pull_request_target.
- Update obsolete Node 16 actions, replace deprecated set-output, correct cache hash patterns and remove Cypress Cloud recording/parallelization credentials. Preserve frontend/backend builds, full unit tests, MariaDB integration, Docker and browser checks.
- Add workflow contract regression tests and an explicit npm run test:signet step. Bound backend Jest worker count and use forceExit for the pre-existing open handles.
- Install build-time devDependencies for production builds: compiler CLI and type declarations are required during compilation.
- Repair the two stale backend config assertions, annotate propagating async methods and handle server-start rejection explicitly, remove invalid frontend tooltip escaping and use the primitive object type. No runtime consensus or dependency version changes.
- Allow the already-locked @parcel/watcher Jest dependency in the backend install-script audit, matching the existing frontend audit allowlist.

## Verification

Workflow contract tests failed before the changes; all 15 now pass. Full backend CI unit tests pass 354/354 including configuration and Signet regressions. Frontend lint passes with warnings only; backend build passes. actionlint validates all workflows. The first push is present on PR #3 but has not produced Actions runs; a manual-dispatch entry point is added to diagnose remote execution separately from PR events. Further remote evidence is pending. No merge or deployment.
