# TASK-008: GitHub-hosted CI

REQ-008. PR #3 targets main. Status: committed and pushed to PR #3; local checks pass; remote execution blocked by GitHub HTTP 422.

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

- Workflow contract regression: 15/15 passed after first reproducing the old runner/event/Cloud configuration failures.
- actionlint v1.7.12: all workflows pass (`-shellcheck=`; shellcheck was unavailable locally).
- Backend full CI unit suite: 354/354 passed, 20 suites. The two original config baseline failures are fixed.
- Explicit Signet regression command: 113/113 passed, 7 suites.
- Backend build and full backend lint: passed (949 existing warnings, no errors).
- Full frontend lint: passed (1862 existing warnings, no errors). Angular compiler/template checking (`ngc -p tsconfig.app.json --noEmit`) passed.
- Backend and frontend install-script audits passed. @parcel/watcher is already present in the unchanged backend lockfile via jest-haste-map; no dependency upgrades are included.
- `git diff --check` passed. Production frontend/Docker builds, browser tests and MariaDB integration have not been verified on a hosted runner because no Actions run was created.

## Remote blocker (2026-11-02 Australia/Melbourne)

The CI commits 0e1b77e15 and 2c95128d6 were pushed to feat/purity-signet-support, updating PR #3. The second push used authenticated HTTPS explicitly and completed successfully, ruling out the earlier post-push credential error as the verification blocker.

Repository Actions permissions API returns `enabled: true`, `allowed_actions: all`. The workflows are active. Neither PR synchronization produced a run/check. Explicit dispatch:

```sh
gh workflow run ci.yml --repo BitcoinPurity/mempool --ref feat/purity-signet-support
```

GitHub returns **HTTP 422: Actions has been disabled for this user**. The branch run listing remains empty. This is an external execution restriction, not a successful or queued hosted-runner test. Reading organization Actions policy also returns HTTP 403 because the current authorization lacks org administration/Actions policy permission; no expanded credentials or policy changes were requested or attempted. The underlying account/organization reason cannot be established from these responses alone.

The owner must resolve the GitHub Actions restriction through their account/organization settings or GitHub Support. After restoration, dispatch the workflow above or synchronize/reopen PR #3 and verify the actual job results. Do not claim remote CI passed before those runs exist. No merge or deployment was performed.
