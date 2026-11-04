import * as fs from 'fs';
import * as path from 'path';
import { scriptHash } from './supply-script';
import { BucketTotals, bucketIndex, emptyBuckets } from './supply-model';
import { SnapshotHeader, SnapshotReader, decompressScriptKey, parseSnapshot } from './utxo-snapshot';

/**
 * Two-pass aggregation of a UTXO snapshot by script. Pass one spreads coins over partition files
 * (a single JS Map is limited to ~16.7M entries, far below the ~60M scripts on mainnet); pass two
 * aggregates one partition at a time and emits one row per script.
 *
 * Partition record: uint16 key length | key | float64 amount (exact for any satoshi value).
 */

export const DEFAULT_PARTITIONS = 256;
const PARTITION_BUFFER_SIZE = 256 * 1024;

export interface PartitionResult {
  header: SnapshotHeader;
  coins: number;
}

export interface BalanceRow {
  scriptHash: Buffer;
  script: Buffer;
  balance: number;
  utxoCount: number;
}

export interface AggregateTotals {
  totalAmount: number;
  utxoCount: number;
  scriptCount: number;
  zeroBalanceScripts: number;
  buckets: BucketTotals[];
}

function fnv1a(key: Buffer): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function partitionPath(dir: string, partition: number): string {
  return path.join(dir, `partition-${partition.toString().padStart(3, '0')}.bin`);
}

/** Pass one: parse the snapshot and append every coin to its key's partition file. */
export function partitionSnapshot(reader: SnapshotReader, dir: string, partitions = DEFAULT_PARTITIONS,
  onProgress?: (coins: number) => void): PartitionResult {
  fs.mkdirSync(dir, { recursive: true });
  const fds: number[] = [];
  const buffers: Buffer[] = [];
  const used: number[] = [];
  try {
    for (let i = 0; i < partitions; i++) {
      fds.push(fs.openSync(partitionPath(dir, i), 'w'));
      buffers.push(Buffer.allocUnsafe(PARTITION_BUFFER_SIZE));
      used.push(0);
    }
    const flush = (partition: number): void => {
      if (used[partition] > 0) {
        fs.writeSync(fds[partition], buffers[partition], 0, used[partition]);
        used[partition] = 0;
      }
    };
    let coins = 0;
    const header = parseSnapshot(reader, (coin) => {
      const partition = fnv1a(coin.key) % partitions;
      const recordLength = 2 + coin.key.length + 8;
      if (recordLength > PARTITION_BUFFER_SIZE - used[partition]) {
        flush(partition);
      }
      if (recordLength > PARTITION_BUFFER_SIZE) {
        const record = Buffer.allocUnsafe(recordLength);
        record.writeUInt16LE(coin.key.length, 0);
        coin.key.copy(record, 2);
        record.writeDoubleLE(coin.amount, 2 + coin.key.length);
        fs.writeSync(fds[partition], record);
      } else {
        const buffer = buffers[partition];
        let offset = used[partition];
        offset = buffer.writeUInt16LE(coin.key.length, offset);
        offset += coin.key.copy(buffer, offset);
        offset = buffer.writeDoubleLE(coin.amount, offset);
        used[partition] = offset;
      }
      coins++;
      if (onProgress && coins % 10_000_000 === 0) {
        onProgress(coins);
      }
    });
    for (let i = 0; i < partitions; i++) {
      flush(i);
    }
    return { header, coins };
  } finally {
    for (const fd of fds) {
      fs.closeSync(fd);
    }
  }
}

/** Aggregate one partition file into per-script totals. */
export function aggregatePartition(file: string): BalanceRow[] {
  const data = fs.readFileSync(file);
  const entries = new Map<string, { key: Buffer, amount: number, count: number }>();
  let offset = 0;
  while (offset < data.length) {
    if (offset + 2 > data.length) {
      throw new Error(`Corrupt supply partition ${file}`);
    }
    const keyLength = data.readUInt16LE(offset);
    offset += 2;
    if (offset + keyLength + 8 > data.length) {
      throw new Error(`Corrupt supply partition ${file}`);
    }
    const key = data.subarray(offset, offset + keyLength);
    offset += keyLength;
    const amount = data.readDoubleLE(offset);
    offset += 8;
    const id = key.toString('latin1');
    const entry = entries.get(id);
    if (entry) {
      entry.amount += amount;
      entry.count++;
    } else {
      entries.set(id, { key, amount, count: 1 });
    }
  }
  const rows: BalanceRow[] = [];
  for (const entry of entries.values()) {
    const script = decompressScriptKey(entry.key);
    rows.push({ scriptHash: scriptHash(script), script, balance: entry.amount, utxoCount: entry.count });
  }
  return rows;
}

export function emptyTotals(): AggregateTotals {
  return { totalAmount: 0, utxoCount: 0, scriptCount: 0, zeroBalanceScripts: 0, buckets: emptyBuckets() };
}

export function addRowToTotals(totals: AggregateTotals, row: BalanceRow): void {
  totals.totalAmount += row.balance;
  totals.utxoCount += row.utxoCount;
  totals.scriptCount++;
  if (row.balance === 0) {
    totals.zeroBalanceScripts++;
  }
  const bucket = totals.buckets[bucketIndex(row.balance)];
  bucket.scriptCount++;
  bucket.amount += row.balance;
}

/** Pass two: aggregate every partition (deleting each once consumed) and hand rows to `onRows`. */
/** @asyncUnsafe */
export async function $aggregatePartitions(dir: string, partitions: number,
  onRows: (rows: BalanceRow[]) => Promise<void>, onProgress?: (partition: number) => void): Promise<AggregateTotals> {
  const totals = emptyTotals();
  for (let i = 0; i < partitions; i++) {
    const file = partitionPath(dir, i);
    const rows = aggregatePartition(file);
    for (const row of rows) {
      addRowToTotals(totals, row);
    }
    await onRows(rows);
    fs.rmSync(file, { force: true });
    if (onProgress) {
      onProgress(i);
    }
  }
  return totals;
}
