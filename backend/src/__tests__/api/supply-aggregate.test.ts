import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { $aggregatePartitions, AggregateTotals, BalanceRow, addRowToTotals, emptyTotals, partitionSnapshot } from '../../api/supply/supply-aggregate';
import { buildBlockDelta } from '../../api/supply/supply-delta';
import { scriptHash } from '../../api/supply/supply-script';
import { SnapshotReader, bufferSource } from '../../api/supply/utxo-snapshot';
import { SupplyInconsistencyError, planDeltaApplication } from '../../repositories/SupplyDistributionRepository';
import { BucketTotals } from '../../api/supply/supply-model';
import { TestCoin, buildSnapshot, p2pkUncompressed, p2pkh, p2wpkh, testOutput, testTx } from './supply-test-utils';

interface Model {
  rows: Map<string, { balance: number, utxoCount: number, script: Buffer }>;
  totals: AggregateTotals;
}

async function aggregate(groups: TestCoin[][], partitions = 4): Promise<Model> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supply-aggregate-'));
  try {
    const { coins } = partitionSnapshot(new SnapshotReader(bufferSource(buildSnapshot(groups))), dir, partitions);
    expect(coins).toBe(groups.flat().length);
    const rows = new Map<string, { balance: number, utxoCount: number, script: Buffer }>();
    const totals = await $aggregatePartitions(dir, partitions, async (batch: BalanceRow[]) => {
      for (const row of batch) {
        rows.set(row.scriptHash.toString('hex'), { balance: row.balance, utxoCount: row.utxoCount, script: row.script });
      }
    });
    expect(fs.readdirSync(dir)).toEqual([]);
    return { rows, totals };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Apply a planned delta to the in-memory model, as the repository does in SQL. */
function apply(model: Model, deltas: ReturnType<typeof buildBlockDelta>): Model {
  const existing = new Map([...model.rows].map(([id, row]) => [id, { balance: row.balance, utxoCount: row.utxoCount }]));
  const plan = planDeltaApplication(model.totals, model.totals.buckets, existing, deltas, 1);
  const rows = new Map(model.rows);
  for (const [hash, script, balance, utxoCount] of plan.upserts) {
    rows.set(hash.toString('hex'), { balance, utxoCount, script });
  }
  for (const hash of plan.deletes) {
    rows.delete(hash.toString('hex'));
  }
  return { rows, totals: { ...plan.totals, buckets: plan.buckets } };
}

function normalize(model: Model): unknown {
  return {
    rows: [...model.rows].sort(([a], [b]) => a.localeCompare(b)).map(([id, r]) => [id, r.balance, r.utxoCount, r.script.toString('hex')]),
    totals: model.totals,
  };
}

const A = p2pkh(0xaa);
const B = p2wpkh(0xbb);
const C = p2pkUncompressed();
const D = p2pkh(0xdd);

const before: TestCoin[][] = [
  [{ vout: 0, height: 1, coinbase: true, amount: 5_000_000_000, script: C }],
  [{ vout: 0, height: 10, amount: 60_000, script: A }, { vout: 1, height: 10, amount: 40_000, script: A }],
  [{ vout: 0, height: 11, amount: 0, script: B }, { vout: 1, height: 11, amount: 250_000_000, script: B }],
];

describe('supply aggregation', () => {
  test('sums every UTXO of a script across partitions into one row', async () => {
    const model = await aggregate(before, 3);
    expect(model.rows.size).toBe(3);
    expect(model.rows.get(scriptHash(A).toString('hex'))).toMatchObject({ balance: 100_000, utxoCount: 2 });
    expect(model.rows.get(scriptHash(C).toString('hex'))?.script).toEqual(C);
    expect(model.totals).toMatchObject({ totalAmount: 5_250_100_000, utxoCount: 5, scriptCount: 3, zeroBalanceScripts: 0 });
    const nonEmpty = model.totals.buckets.filter((b: BucketTotals) => b.scriptCount > 0).map((b) => [b.bucket, b.scriptCount, b.amount]);
    expect(nonEmpty).toEqual([[1, 1, 100_000], [4, 1, 250_000_000], [5, 1, 5_000_000_000]]);
  });

  test('counts zero-balance scripts separately and in the lowest range', () => {
    const totals = emptyTotals();
    addRowToTotals(totals, { scriptHash: Buffer.alloc(32), script: B, balance: 0, utxoCount: 3 });
    expect(totals).toMatchObject({ scriptCount: 1, zeroBalanceScripts: 1, utxoCount: 3 });
    expect(totals.buckets[0].scriptCount).toBe(1);
  });

  test('bootstrap followed by a block equals bootstrapping after the block', async () => {
    // Block: spends both A outputs and C, creates D, pays A back once, adds dust to B, plus an
    // output created and spent within the block and an OP_RETURN output.
    const block = [
      testTx('cb', ['coinbase'], [testOutput(D, 312_500_000), testOutput(Buffer.from('6a00', 'hex'), 0)]),
      testTx('t1', [testOutput(A, 60_000), testOutput(A, 40_000), testOutput(C, 5_000_000_000)],
        [testOutput(D, 4_999_000_000), testOutput(A, 99_000), testOutput(B, 1)]),
      testTx('t2', [testOutput(D, 4_999_000_000)], [testOutput(p2pkh(0xee), 4_998_999_000)]),
      testTx('t3', [testOutput(p2pkh(0xee), 4_998_999_000)], [testOutput(D, 4_998_998_000)]),
    ];
    const after: TestCoin[][] = [
      [{ vout: 0, height: 11, amount: 0, script: B }, { vout: 1, height: 11, amount: 250_000_000, script: B }],
      [{ vout: 0, height: 12, coinbase: true, amount: 312_500_000, script: D }],
      [{ vout: 1, height: 12, amount: 99_000, script: A }, { vout: 2, height: 12, amount: 1, script: B }],
      [{ vout: 0, height: 12, amount: 4_998_998_000, script: D }],
    ];
    const incremental = apply(await aggregate(before), buildBlockDelta(block, 1));
    const direct = await aggregate(after);
    expect(normalize(incremental)).toEqual(normalize(direct));

    const undone = apply(incremental, buildBlockDelta(block, -1));
    expect(normalize(undone)).toEqual(normalize(await aggregate(before)));
  });

  test('rejects deltas that would make a balance negative', async () => {
    const model = await aggregate(before);
    const spendTooMuch = [testTx('x', [testOutput(A, 200_000)], [])];
    expect(() => apply(model, buildBlockDelta(spendTooMuch))).toThrow(SupplyInconsistencyError);
    const unknownScript = [testTx('y', [testOutput(D, 1)], [])];
    expect(() => apply(model, buildBlockDelta(unknownScript))).toThrow(SupplyInconsistencyError);
  });

  test('block delta requires prevouts and skips unspendable outputs', () => {
    const tx = testTx('z', [testOutput(A, 5)], [testOutput(Buffer.from('6a', 'hex'), 0), testOutput(Buffer.alloc(10001, 0x51), 1)]);
    expect(buildBlockDelta([tx]).map((d) => [d.amount, d.utxos])).toEqual([[-5, -1]]);
    tx.vin[0].prevout = null;
    expect(() => buildBlockDelta([tx])).toThrow(/Missing prevout/);
  });
});
