import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import config from '../../config';
import logger from '../../logger';
import bitcoinClient from '../bitcoin/bitcoin-client';
import supplyDumpClient, { SupplyDumpClient } from './supply-rpc-client';
import supplyRepository, { SupplyDistributionRepository, SupplyState } from '../../repositories/SupplyDistributionRepository';
import { BootstrapWorkerInput, BootstrapWorkerMessage, BootstrapWorkerResult, STAGING_TABLE } from './supply-bootstrap-worker';

export const SNAPSHOT_PREFIX = 'purity-supply-utxo-';
const PARTITION_FILE = /^partition-\d{3}\.bin$/;

/** Bootstrap scratch directory; always a dedicated subdirectory so cleanup never touches other files. */
export function supplyWorkDir(): string {
  return path.join(config.SUPPLY_DISTRIBUTION.TEMP_DIR || config.MEMPOOL.CACHE_DIR, 'supply-bootstrap');
}

/** Remove leftover snapshot files (our naming only) and partition files. */
export function cleanupSupplyFiles(snapshotDir: string, workDir: string): void {
  if (fs.existsSync(snapshotDir)) {
    for (const name of fs.readdirSync(snapshotDir)) {
      if (name.startsWith(SNAPSHOT_PREFIX)) {
        fs.rmSync(path.join(snapshotDir, name), { force: true });
      }
    }
  }
  if (fs.existsSync(workDir)) {
    for (const name of fs.readdirSync(workDir)) {
      if (PARTITION_FILE.test(name)) {
        fs.rmSync(path.join(workDir, name), { force: true });
      }
    }
    try {
      fs.rmdirSync(workDir);
    } catch (e) {
      // not empty or already gone: leave it
    }
  }
}

export type WorkerRunner = (input: BootstrapWorkerInput) => Promise<BootstrapWorkerResult>;

export const runBootstrapWorkerThread: WorkerRunner = (input) => new Promise((resolve, reject) => {
  const worker = new Worker(path.resolve(__dirname, './supply-bootstrap-worker.js'), { workerData: { supplyBootstrap: input } });
  let settled = false;
  const settle = (fn: () => void): void => {
    if (!settled) {
      settled = true;
      fn();
      worker.terminate().catch(() => undefined);
    }
  };
  worker.on('message', (message: BootstrapWorkerMessage) => {
    if (message.type === 'progress') {
      logger.info(`Supply bootstrap: ${message.message}`);
    } else if (message.type === 'done') {
      settle(() => resolve(message.result));
    } else {
      settle(() => reject(new Error(message.message)));
    }
  });
  worker.on('error', (error) => settle(() => reject(error)));
  worker.on('exit', (code) => settle(() => reject(new Error(`Supply bootstrap worker exited with code ${code}`))));
});

export interface SupplyBootstrapDeps {
  rpc: { getBlockchainInfo(): Promise<any> };
  dumpClient: SupplyDumpClient;
  repository: SupplyDistributionRepository;
  runWorker: WorkerRunner;
  snapshotDir: string;
  workDir: string;
}

export class SupplyBootstrap {
  private deps: SupplyBootstrapDeps;

  constructor(deps: Partial<SupplyBootstrapDeps> = {}) {
    this.deps = {
      rpc: bitcoinClient,
      dumpClient: supplyDumpClient,
      repository: supplyRepository,
      runWorker: runBootstrapWorkerThread,
      snapshotDir: config.SUPPLY_DISTRIBUTION.SNAPSHOT_DIR,
      workDir: supplyWorkDir(),
      ...deps,
    };
  }

  /** Dump the node's UTXO set once and load per-script balances. */
  /** @asyncUnsafe */
  async $run(): Promise<SupplyState> {
    const { rpc, dumpClient, repository, runWorker, snapshotDir, workDir } = this.deps;
    const info = await rpc.getBlockchainInfo();
    if (info.initialblockdownload || info.blocks !== info.headers) {
      throw new Error('node is not fully synced');
    }
    if (!fs.existsSync(snapshotDir)) {
      throw new Error(`SNAPSHOT_DIR ${snapshotDir} does not exist`);
    }
    cleanupSupplyFiles(snapshotDir, workDir);
    const snapshotPath = path.join(snapshotDir, `${SNAPSHOT_PREFIX}${Date.now()}.dat`);
    const started = Date.now();
    logger.notice(`Supply bootstrap: dumping the UTXO set at tip ${info.blocks} to ${snapshotPath}; the node may stall while it runs`);
    try {
      const dump = await dumpClient.dumpTxOutSet(snapshotPath, 'latest');
      logger.notice(`Supply bootstrap: dumped ${dump.coins_written} coins at ${dump.base_height} in ${Math.round((Date.now() - started) / 1000)}s`);
      try {
        fs.accessSync(snapshotPath, fs.constants.R_OK);
      } catch (e) {
        throw new Error(`Cannot read ${snapshotPath}; grant the backend user read access to SNAPSHOT_DIR (see docs/supply-distribution.md)`);
      }
      const result = await runWorker({
        snapshotPath,
        tempDir: workDir,
        database: config.SUPPLY_DISTRIBUTION.DATABASE,
        expectedBaseHash: dump.base_hash,
        expectedCoins: dump.coins_written,
        indexTimeout: config.SUPPLY_DISTRIBUTION.DUMP_TIMEOUT,
      });
      const state = await repository.$finishBootstrap(STAGING_TABLE, result.totals, { height: dump.base_height, hash: dump.base_hash });
      logger.notice(`Supply bootstrap: loaded ${state.scriptCount} scripts / ${state.utxoCount} UTXOs at ${state.height} ` +
        `in ${Math.round((Date.now() - started) / 1000)}s`);
      return state;
    } finally {
      cleanupSupplyFiles(snapshotDir, workDir);
    }
  }
}
