# TASK-007: Purity Signet support

Requirement: REQ-007. Target: main. Status: implemented and locally verified on feat/purity-signet-support; no push, merge or deployment.

## Technical assessment before implementation

Reference: [v1.1.0](https://github.com/saltduck/bitcoinpurity/releases/tag/v1.1.0), commit 83dfae591af3d1dfd7ccd803516279f3b72460b0. Verified current master 443f3bfec747fd4e865001741aeda243fcad3fec on 2026-11-01. The three later commits do not change pow.cpp, either chainparams.cpp, consensus parameters, deploymentstatus.h or pow_tests.cpp. Inspected those files in both the release checkout and current remote source.

- ASERT currently defaults every Bitcoin network to Mainnet activation 961636, anchor 961632 and Mainnet powLimit. Official Signet uses 327022 / 327017 and 0x00000377ae000000000000000000000000000000000000000000000000000000. A Signet anchor target is greater than Mainnet powLimit and currently throws.
- CalculateASERT and CalculateSignetASERT use identical signed integer division, polynomial, arithmetic shifts and compact encoding. The C++ target-width assertions differ (224 versus 239 bits); official Signet powLimit is 234 bits. Both use anchor parent time and previous height minus anchor height. CheckDifficultyBits permits a harder claimed target at activation only; afterward nBits equality applies. The explorer must use observed bits for history and describe the activation forecast as a reference ceiling.
- Mainnet node consensus activates at 961637, while this explorer deliberately defaults its ASERT estimate to 961636. Preserve that deployed behavior and the independent RDTS height 961637.
- RDTS status currently excludes Signet. Structural classification is hypothetical and lacks full consensus context; accepted historical transactions must retain that meaning. The selected Signet coinbase witness commitment can be 195 bytes after activation, exceeding the generic OP_RETURN classifier limit of 83 bytes.
- Disk cache filenames share CACHE_DIR by default; database defaults to mempool. PID filenames already contain the database name. Redis already selects distinct Mainnet/Signet logical databases. Signet needs isolated defaults and a documented separate DB/user/cache/runtime setup.
- RPC chain=signet cannot identify the post-fork chain. Check the activation hash before exposing data and recheck while running, including Electrum. Below activation identity is pending; do not claim verified Purity identity.
- Difficulty history already records every observed nBits change. Hashrate comes from node getnetworkhashps; block difficulty, subsidy and fees come from actual chain data. Frontend difficulty components already consume algorithm=asert and nextRetargetHeight; network routing already supports /signet. No redesign or database migration is needed.

## Plan

1. Add failing consensus/configuration/chain identity/RDTS regression tests using official parameters and C++ fixtures.
2. Resolve network parameters and isolated defaults, wire ASERT forecasts and official anchors, add RPC/Electrum identity gating and Signet RDTS compatibility.
3. Add example and operational documentation; run focused and affected tests, build, inspect diff, commit locally on feat/purity-signet-support.

## Implemented result

- Typed official Signet profile selected before generic configuration merging, strict profile/dependency validation and isolated cache, DB, ports and cookie paths. Mainnet's two existing height overrides and ASERT API signatures remain supported; the Mainnet raw-target forecast remains unchanged.
- Signet uses its own powLimit, official anchor bits and anchor parent time. Compact-rounding is applied to its forecast. Activation acceptance is represented by `checkDifficultyBits`; the API explicitly marks the activation reference ceiling while block history uses observed nBits. Legacy estimates remain before activation.
- Startup and polling identity validation cover Core and the configured indexer; Electrum hashes its actual activation header using protocol 1.4. IBD below activation is pending. Failure gates HTTP/WebSocket data; recovery is retried.
- Signet permanent RDTS status and selected coinbase commitment classification are supported. Historical flags remain hypothetical. The only frontend behavior change is Signet-specific explanatory text; its difficulty type gains one optional field.
- Added a lightweight production example and [Contabo deployment/validation guide](../purity-signet.md). No node source changes, dependency changes, database migrations or Mainnet data reindex.

## Validation

- `cd backend && npm run build`: passed, including TypeScript and resource generation.
- Focused Jest: `node_modules/.bin/jest --runInBand --coverage=false asert.test.ts electrum-api.test.ts bip110-classification.test.ts bip110-deployment.test.ts purity-config.test.ts purity-signet.test.ts difficulty-adjustment.test.ts`: **113/113 passed, 7 suites**.
- Full backend Jest (`--runInBand --coverage=false --forceExit`): **352 passed, 2 failed, 20 suites (19 passed)**. Both failures are existing configuration baselines: missing POOLS_OVERLAY_PATH in expected defaults, and missing AUDIT_GBT/POOLS_OVERLAY_PATH in the override fixture. Reproduced both failures from original HEAD 5d524d31f in an isolated temporary baseline checkout (4 passed / 2 failed). They were not changed as part of this task. Force-exit is required by existing open handles in the full suite.
- The initial dependency install omitted scripts; three full-suite imports were initially blocked by the missing native GBT addon. Restored the existing locally built project addon into the ignored backend build directory; all three suites then passed. No dependency manifest/lockfile or Rust source changed.
- Mainnet differential check against original HEAD ASERT source: **63/63 identical targets**, covering three reference targets, three heights, fractional exponents, growth/decay and clamps.
- Full-node C++ binary: `test_bitcoin --run_test=pow_tests --log_level=message`: **25/25 passed**. The inspected node files are clean at v1.1.0; no node source was modified. Separately compiled the exact CalculateSignetASERT function in a temporary reference harness: official next-block bits are **327022 = 0x1d153796** and **327023 = 0x1d15b5bf**, matching the committed real headers.
- Official header fixtures were read through P2P getheaders from the public seed in the release. Hash/link checks cover 327017 through 327023, anchored by the published activation hash; shared parent 327021 was independently checked using the public Core Signet explorer. The official activation happens to equal its computed reference; the harder-target exception is covered by the established node fixture and explicit boundary tests. Ordinary CI requires no live node.
- `cd frontend && node_modules/.bin/ngc -p tsconfig.app.json --noEmit`: passed, including Angular template checking. Frontend dependencies were restored from the unchanged lockfile because local node_modules initially contained empty package directories.
- ESLint on changed backend sources: two pre-existing no-unhandled-await errors, in Blocks.setBlocks at the cached-pool refresh call and Server.startServer at the cached-pool refresh call. Original HEAD reproduces exactly those two errors and the same **103 warnings**. No new lint errors or warnings; new modules are clean. The lint command is not reported as passed.
- Compiled config loader accepts the production Signet example. `git diff --check`: passed. Dependency manifests/lockfiles and database-migration.ts have no changes.

## Operational limits

No Contabo service was started and no production data was changed. Actual MariaDB/socket authentication, node/Electrs synchronization, simultaneous production processes and resource use require host acceptance using the deployment guide. Use fresh Signet storage and independently separated custom cache/DB paths. The backend checks known Mainnet default collisions, not every possible operator-defined path alias. The optional second min-fee RPC remains disabled in the example; if enabled, configure it for the same Purity Signet chain.

Identity checks are periodic and permit shared history below activation; they cannot prove the future fork while a source is below 327022. Failure suspends new data serving/ingestion; operations already in flight are not cancelled. Structural BIP110 classification lacks spent-output grandfathering and full execution context and is not a substitute for node consensus validation.

## Modified files


- `README.md`
- `backend/mempool-config.purity-signet.example.json`
- `backend/src/__fixtures__/purity-signet-headers.json`
- `backend/src/__fixtures__/signet-asert.json`
- `backend/src/__tests__/api/asert.test.ts`
- `backend/src/__tests__/api/bip110-classification.test.ts`
- `backend/src/__tests__/api/bip110-deployment.test.ts`
- `backend/src/__tests__/api/difficulty-adjustment.test.ts`
- `backend/src/__tests__/api/electrum-api.test.ts`
- `backend/src/__tests__/api/purity-signet.test.ts`
- `backend/src/__tests__/purity-config.test.ts`
- `backend/src/api/asert.ts`
- `backend/src/api/bip110-deployment.ts`
- `backend/src/api/bitcoin/electrum-api.ts`
- `backend/src/api/blocks.ts`
- `backend/src/api/common.ts`
- `backend/src/api/difficulty-adjustment.ts`
- `backend/src/api/purity-signet.ts`
- `backend/src/config.ts`
- `backend/src/index.ts`
- `backend/src/mempool.interfaces.ts`
- `backend/src/purity-config.ts`
- `docs/api-contract.md`
- `docs/architecture.md`
- `docs/migration-report.md`
- `docs/purity-signet.md`
- `docs/requirements/product-spec.md`
- `docs/tasks/TASK-007.md`
- `docs/tasks/index.md`
- `frontend/src/app/components/transaction/transaction.component.html`
- `frontend/src/app/interfaces/node-api.interface.ts`
- `input/requirements.md`
