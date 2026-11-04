import { PoolConnection } from 'mysql2/promise';
import { DB } from '../database';
import { supplyDb } from '../api/supply/supply-database';
import { ScriptDelta } from '../api/supply/supply-delta';
import { AggregateTotals } from '../api/supply/supply-aggregate';
import { BucketTotals, bucketIndex } from '../api/supply/supply-model';

export type SupplyStatus = 'bootstrapping' | 'ready' | 'stale';

export interface SupplyState {
  height: number;
  hash: string;
  totalAmount: number;
  utxoCount: number;
  scriptCount: number;
  zeroBalanceScripts: number;
  bootstrapHeight: number;
  status: SupplyStatus;
  updatedAt: number;
}

export interface BlockRef {
  height: number;
  hash: string;
}

export interface BalanceRecord {
  scriptHash: Buffer;
  script: Buffer;
  balance: number;
  utxoCount: number;
}

/** Raised when applying a delta would leave the table inconsistent (e.g. a negative balance). */
export class SupplyInconsistencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupplyInconsistencyError';
  }
}

/** Raised when the stored state moved since the caller read it. */
export class SupplyStateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupplyStateConflictError';
  }
}

const SELECT_BATCH = 1000;
const WRITE_BATCH = 1000;

function toState(row: any): SupplyState {
  return {
    height: Number(row.height),
    hash: row.hash,
    totalAmount: Number(row.total_amount),
    utxoCount: Number(row.utxo_count),
    scriptCount: Number(row.script_count),
    zeroBalanceScripts: Number(row.zero_balance_scripts),
    bootstrapHeight: Number(row.bootstrap_height),
    status: row.status,
    updatedAt: Math.floor(new Date(row.updated_at).getTime() / 1000),
  };
}

function toBucket(row: any): BucketTotals {
  return {
    bucket: Number(row.bucket),
    minSats: Number(row.min_sats),
    maxSats: row.max_sats === null ? null : Number(row.max_sats),
    scriptCount: Number(row.script_count),
    amount: Number(row.amount),
  };
}

function toBalance(row: any): BalanceRecord {
  return {
    scriptHash: row.script_hash,
    script: row.script,
    balance: Number(row.balance),
    utxoCount: Number(row.utxo_count),
  };
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

export interface DeltaPlan {
  upserts: [Buffer, Buffer, number, number][];
  deletes: Buffer[];
  buckets: BucketTotals[];
  totals: { totalAmount: number, utxoCount: number, scriptCount: number, zeroBalanceScripts: number };
}

/**
 * Pure part of a block application: new balances, rows to write/delete, and updated bucket and
 * state totals. `existing` maps script hash hex to the stored balance. Throws on inconsistency.
 */
export function planDeltaApplication(state: Pick<SupplyState, 'totalAmount' | 'utxoCount' | 'scriptCount' | 'zeroBalanceScripts'>,
  currentBuckets: BucketTotals[], existing: Map<string, { balance: number, utxoCount: number }>, deltas: ScriptDelta[],
  height: number): DeltaPlan {
  const buckets = currentBuckets.map((b) => ({ ...b }));
  const upserts: [Buffer, Buffer, number, number][] = [];
  const deletes: Buffer[] = [];
  let totalAmount = state.totalAmount;
  let utxoCount = state.utxoCount;
  let scriptCount = state.scriptCount;
  let zeroBalanceScripts = state.zeroBalanceScripts;
  for (const delta of deltas) {
    const old = existing.get(delta.scriptHash.toString('hex'));
    const balance = (old?.balance ?? 0) + delta.amount;
    const utxos = (old?.utxoCount ?? 0) + delta.utxos;
    if (balance < 0 || utxos < 0 || (utxos === 0 && balance !== 0)) {
      throw new SupplyInconsistencyError(
        `Script ${delta.scriptHash.toString('hex')} would have balance ${balance} with ${utxos} UTXOs at ${height}`);
    }
    if (old) {
      const bucket = buckets[bucketIndex(old.balance)];
      bucket.scriptCount--;
      bucket.amount -= old.balance;
      scriptCount--;
      if (old.balance === 0) {
        zeroBalanceScripts--;
      }
    }
    if (utxos > 0) {
      const bucket = buckets[bucketIndex(balance)];
      bucket.scriptCount++;
      bucket.amount += balance;
      scriptCount++;
      if (balance === 0) {
        zeroBalanceScripts++;
      }
      upserts.push([delta.scriptHash, delta.script, balance, utxos]);
    } else {
      deletes.push(delta.scriptHash);
    }
    totalAmount += delta.amount;
    utxoCount += delta.utxos;
  }
  if (totalAmount < 0 || utxoCount < 0 || buckets.some((b) => b.scriptCount < 0 || b.amount < 0)) {
    throw new SupplyInconsistencyError(`Supply totals would become negative at ${height}`);
  }
  return { upserts, deletes, buckets, totals: { totalAmount, utxoCount, scriptCount, zeroBalanceScripts } };
}

export class SupplyDistributionRepository {
  constructor(private db: DB = supplyDb) { }

  /** @asyncUnsafe */
  async $getState(connection?: PoolConnection): Promise<SupplyState | null> {
    const [rows] = await this.db.query<any[]>(`SELECT * FROM supply_state WHERE id = 1${connection ? ' FOR UPDATE' : ''}`,
      [], 'debug', connection);
    return rows.length ? toState(rows[0]) : null;
  }

  /** @asyncUnsafe */
  async $getBuckets(connection?: PoolConnection): Promise<BucketTotals[]> {
    const [rows] = await this.db.query<any[]>(`SELECT * FROM supply_buckets ORDER BY bucket${connection ? ' FOR UPDATE' : ''}`,
      [], 'debug', connection);
    return rows.map(toBucket);
  }

  /** @asyncUnsafe */
  async $setStatus(status: SupplyStatus): Promise<void> {
    await this.db.query('UPDATE supply_state SET status = ? WHERE id = 1', [status]);
  }

  /** @asyncUnsafe */
  async $getTopBalances(offset: number, limit: number): Promise<BalanceRecord[]> {
    const [rows] = await this.db.query<any[]>(
      'SELECT script_hash, script, balance, utxo_count FROM supply_balances ORDER BY balance DESC, script_hash DESC LIMIT ? OFFSET ?',
      [limit, offset]);
    return rows.map(toBalance);
  }

  /** The top `limit` balances in rank order; served from the (balance, script_hash) index. */
  /** @asyncUnsafe */
  async $getTopBalanceAmounts(limit: number): Promise<number[]> {
    const [rows] = await this.db.query<any[]>(
      'SELECT balance FROM supply_balances ORDER BY balance DESC, script_hash DESC LIMIT ?', [limit]);
    return rows.map((row) => Number(row.balance));
  }

  /** The row ranked `rank` (1-based), i.e. the inclusion threshold for the top `rank` list. */
  /** @asyncUnsafe */
  async $getRankedRow(rank: number): Promise<BalanceRecord | null> {
    const rows = await this.$getTopBalances(rank - 1, 1);
    return rows.length ? rows[0] : null;
  }

  /** @asyncUnsafe */
  async $getBalance(hash: Buffer): Promise<BalanceRecord | null> {
    const [rows] = await this.db.query<any[]>(
      'SELECT script_hash, script, balance, utxo_count FROM supply_balances WHERE script_hash = ?', [hash]);
    return rows.length ? toBalance(rows[0]) : null;
  }

  /** 1-based rank under the ORDER BY balance DESC, script_hash DESC ordering. */
  /** @asyncUnsafe */
  async $getRank(record: BalanceRecord): Promise<number> {
    const [above] = await this.db.query<any[]>('SELECT COUNT(*) AS count FROM supply_balances WHERE balance > ?', [record.balance]);
    const [ties] = await this.db.query<any[]>('SELECT COUNT(*) AS count FROM supply_balances WHERE balance = ? AND script_hash > ?',
      [record.balance, record.scriptHash]);
    return Number(above[0].count) + Number(ties[0].count) + 1;
  }

  /**
   * Swap in the staging table built by the bootstrap worker, then record buckets and state.
   * RENAME TABLE commits implicitly; if the process stops before the state is written the state stays
   * empty and the next start bootstraps again.
   */
  /** @asyncUnsafe */
  async $finishBootstrap(stagingTable: string, totals: AggregateTotals, block: BlockRef): Promise<SupplyState> {
    await this.db.query('DROP TABLE IF EXISTS supply_balances_old');
    await this.db.query(`RENAME TABLE supply_balances TO supply_balances_old, \`${stagingTable}\` TO supply_balances`);
    await this.db.query('DROP TABLE supply_balances_old');
    await this.db.$withTransaction(/** @asyncUnsafe */ async (connection) => {
      await this.db.query('DELETE FROM supply_buckets', [], 'debug', connection);
      await this.db.query('INSERT INTO supply_buckets (bucket, min_sats, max_sats, script_count, amount) VALUES ?',
        [totals.buckets.map((b) => [b.bucket, b.minSats, b.maxSats, b.scriptCount, b.amount])], 'debug', connection);
      await this.db.query(`REPLACE INTO supply_state (id, height, hash, total_amount, utxo_count, script_count,
        zero_balance_scripts, bootstrap_height, status) VALUES (1, ?, ?, ?, ?, ?, ?, ?, 'bootstrapping')`,
        [block.height, block.hash, totals.totalAmount, totals.utxoCount, totals.scriptCount, totals.zeroBalanceScripts, block.height],
        'debug', connection);
    });
    const state = await this.$getState();
    if (!state) {
      throw new Error('Supply state missing after bootstrap');
    }
    return state;
  }

  /**
   * Atomically move the state from `from` to `to` by applying per-script deltas (a block, or its
   * negation when undoing). Rejects when the stored state is not `from`.
   */
  /** @asyncUnsafe */
  async $applyDelta(from: BlockRef, to: BlockRef, deltas: ScriptDelta[]): Promise<SupplyState> {
    return this.db.$withTransaction(/** @asyncUnsafe */ async (connection) => {
      const state = await this.$getState(connection);
      if (!state || state.height !== from.height || state.hash !== from.hash) {
        throw new SupplyStateConflictError(`Supply state is not at ${from.height} ${from.hash}`);
      }
      const buckets = await this.$getBuckets(connection);

      const existing = new Map<string, { balance: number, utxoCount: number }>();
      for (const batch of chunks(deltas, SELECT_BATCH)) {
        const [rows] = await this.db.query<any[]>(
          'SELECT script_hash, balance, utxo_count FROM supply_balances WHERE script_hash IN (?) FOR UPDATE',
          [batch.map((d) => d.scriptHash)], 'debug', connection);
        for (const row of rows) {
          existing.set(Buffer.from(row.script_hash).toString('hex'), { balance: Number(row.balance), utxoCount: Number(row.utxo_count) });
        }
      }

      const plan = planDeltaApplication(state, buckets, existing, deltas, to.height);
      const { upserts, deletes } = plan;
      const { totalAmount, utxoCount, scriptCount, zeroBalanceScripts } = plan.totals;

      for (const batch of chunks(upserts, WRITE_BATCH)) {
        await this.db.query(`INSERT INTO supply_balances (script_hash, script, balance, utxo_count) VALUES ?
          ON DUPLICATE KEY UPDATE balance = VALUES(balance), utxo_count = VALUES(utxo_count)`, [batch], 'debug', connection);
      }
      for (const batch of chunks(deletes, WRITE_BATCH)) {
        await this.db.query('DELETE FROM supply_balances WHERE script_hash IN (?)', [batch], 'debug', connection);
      }
      for (const bucket of plan.buckets) {
        await this.db.query('UPDATE supply_buckets SET script_count = ?, amount = ? WHERE bucket = ?',
          [bucket.scriptCount, bucket.amount, bucket.bucket], 'debug', connection);
      }
      await this.db.query(`UPDATE supply_state SET height = ?, hash = ?, total_amount = ?, utxo_count = ?, script_count = ?,
        zero_balance_scripts = ? WHERE id = 1`, [to.height, to.hash, totalAmount, utxoCount, scriptCount, zeroBalanceScripts],
      'debug', connection);
      return { ...state, height: to.height, hash: to.hash, totalAmount, utxoCount, scriptCount, zeroBalanceScripts };
    });
  }
}

export default new SupplyDistributionRepository();
