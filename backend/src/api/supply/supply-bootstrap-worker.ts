import * as fs from 'fs';
import { parentPort, workerData } from 'worker_threads';
import { DB } from '../../database';
import { $aggregatePartitions, AggregateTotals, BalanceRow, DEFAULT_PARTITIONS, partitionSnapshot } from './supply-aggregate';
import { balancesTableSql } from './supply-database';
import { SnapshotHeader, SnapshotReader, fileSource } from './utxo-snapshot';

export const STAGING_TABLE = 'supply_balances_new';
const INSERT_BATCH_ROWS = 5000;
const INSERT_BATCH_BYTES = 2 * 1024 * 1024;
const MAX_INSERTS_IN_FLIGHT = 4;

export interface BootstrapWorkerInput {
  snapshotPath: string;
  tempDir: string;
  database: string;
  expectedBaseHash: string;
  expectedCoins: number;
  /** Timeout for the long secondary-index build, in ms. */
  indexTimeout: number;
}

export interface BootstrapWorkerResult {
  header: SnapshotHeader;
  totals: AggregateTotals;
}

export type BootstrapWorkerMessage =
  | { type: 'progress', message: string }
  | { type: 'done', result: BootstrapWorkerResult }
  | { type: 'error', message: string };

/** Insert rows in byte- and row-bounded batches with a few statements in flight. */
export function createBatchInserter(db: DB, table: string): { add: (rows: BalanceRow[]) => Promise<void>, finish: () => Promise<void> } {
  let batch: [Buffer, Buffer, number, number][] = [];
  let batchBytes = 0;
  const inFlight = new Set<Promise<void>>();
  let failure: unknown = null;

  /** @asyncUnsafe */
  const send = async (): Promise<void> => {
    if (!batch.length) {
      return;
    }
    const values = batch;
    batch = [];
    batchBytes = 0;
    const promise = db.query(`INSERT INTO \`${table}\` (script_hash, script, balance, utxo_count) VALUES ?`, [values])
      .then(() => undefined)
      .catch((e) => { failure = failure ?? e; })
      .finally(() => { inFlight.delete(promise); });
    inFlight.add(promise);
    while (inFlight.size >= MAX_INSERTS_IN_FLIGHT) {
      await Promise.race(inFlight);
    }
    if (failure) {
      throw failure;
    }
  };

  /** @asyncUnsafe */
  const add = async (rows: BalanceRow[]): Promise<void> => {
    for (const row of rows) {
      batch.push([row.scriptHash, row.script, row.balance, row.utxoCount]);
      batchBytes += row.script.length + 64;
      if (batch.length >= INSERT_BATCH_ROWS || batchBytes >= INSERT_BATCH_BYTES) {
        await send();
      }
    }
  };

  /** @asyncUnsafe */
  const finish = async (): Promise<void> => {
    await send();
    await Promise.all(inFlight);
    if (failure) {
      throw failure;
    }
  };

  return { add, finish };
}

/** @asyncUnsafe */
export async function $runBootstrapWorker(input: BootstrapWorkerInput, progress: (message: string) => void,
  db: DB = new DB({ database: input.database })): Promise<BootstrapWorkerResult> {
  const started = Date.now();
  const fd = fs.openSync(input.snapshotPath, 'r');
  let partitioned;
  try {
    partitioned = partitionSnapshot(new SnapshotReader(fileSource(fd)), input.tempDir, DEFAULT_PARTITIONS,
      (coins) => progress(`partitioned ${coins} coins`));
  } finally {
    fs.closeSync(fd);
  }
  const { header, coins } = partitioned;
  if (header.baseBlockHash !== input.expectedBaseHash) {
    throw new Error(`Snapshot base hash ${header.baseBlockHash} does not match dumptxoutset result ${input.expectedBaseHash}`);
  }
  if (header.coinsCount !== input.expectedCoins || coins !== input.expectedCoins) {
    throw new Error(`Snapshot coin count mismatch: header ${header.coinsCount}, parsed ${coins}, node ${input.expectedCoins}`);
  }
  progress(`partitioned ${coins} coins in ${Math.round((Date.now() - started) / 1000)}s`);

  await db.query(`DROP TABLE IF EXISTS \`${STAGING_TABLE}\``);
  await db.query(balancesTableSql(STAGING_TABLE, false));
  const inserter = createBatchInserter(db, STAGING_TABLE);
  const totals = await $aggregatePartitions(input.tempDir, DEFAULT_PARTITIONS, (rows) => inserter.add(rows), (partition) => {
    if ((partition + 1) % 32 === 0) {
      progress(`aggregated ${partition + 1}/${DEFAULT_PARTITIONS} partitions`);
    }
  });
  await inserter.finish();
  if (totals.utxoCount !== coins) {
    throw new Error(`Aggregated UTXO count ${totals.utxoCount} does not match ${coins} parsed coins`);
  }
  progress(`inserted ${totals.scriptCount} scripts; building balance index`);
  await db.query({ sql: `ALTER TABLE \`${STAGING_TABLE}\` ADD KEY balance (balance, script_hash)`, timeout: input.indexTimeout });
  progress(`bootstrap aggregation finished in ${Math.round((Date.now() - started) / 1000)}s`);
  await db.close();
  return { header, totals };
}

if (parentPort && workerData?.supplyBootstrap) {
  const port = parentPort;
  $runBootstrapWorker(workerData.supplyBootstrap as BootstrapWorkerInput,
    (message) => port.postMessage({ type: 'progress', message } satisfies BootstrapWorkerMessage))
    .then((result) => port.postMessage({ type: 'done', result } satisfies BootstrapWorkerMessage))
    .catch((e) => port.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) } satisfies BootstrapWorkerMessage));
}
