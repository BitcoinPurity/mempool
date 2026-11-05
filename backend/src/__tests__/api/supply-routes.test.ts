jest.mock('../../api/bitcoin/bitcoin-client', () => ({ __esModule: true, default: {} }));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SupplyDistributionRoutes } from '../../api/supply/supply-distribution.routes';
import { scriptHash, supplyNetwork } from '../../api/supply/supply-script';
import { emptyBuckets } from '../../api/supply/supply-model';
import { BalanceRecord, SupplyDistributionRepository, SupplyState } from '../../repositories/SupplyDistributionRepository';
import { SupplyBootstrap, cleanupSupplyFiles, SNAPSHOT_PREFIX } from '../../api/supply/supply-bootstrap';
import { createBatchInserter } from '../../api/supply/supply-bootstrap-worker';
import { DB } from '../../database';
import { emptyTotals } from '../../api/supply/supply-aggregate';
import { BLOCK1_PUBKEY, p2pkUncompressed } from './supply-test-utils';

const state: SupplyState = {
  height: 900000, hash: 'ab'.repeat(32), totalAmount: 1_000_000, utxoCount: 10, scriptCount: 4, zeroBalanceScripts: 1,
  bootstrapHeight: 899990, status: 'ready', updatedAt: 1700000000,
};

const wpkh = Buffer.from('0014751e76e8199196d454941c45d1b3a323f1433bd6', 'hex');
const records: BalanceRecord[] = [
  { scriptHash: scriptHash(p2pkUncompressed()), script: p2pkUncompressed(), balance: 600_000, utxoCount: 1 },
  { scriptHash: scriptHash(wpkh), script: wpkh, balance: 300_000, utxoCount: 2 },
  { scriptHash: Buffer.alloc(32, 1), script: Buffer.alloc(100, 0x51), balance: 100_000, utxoCount: 1 },
];

function fakeRepository(current: SupplyState | null = state) {
  return {
    $getState: jest.fn(async () => current),
    $getBuckets: jest.fn(async () => emptyBuckets()),
    $getTopBalances: jest.fn(async (offset: number, limit: number) => records.slice(offset, offset + limit)),
    $getTopBalanceAmounts: jest.fn(async (limit: number) => records.slice(0, limit).map((r) => r.balance)),
    $getRankedRow: jest.fn(async (rank: number) => records[rank - 1] ?? null),
    $getBalance: jest.fn(async (hash: Buffer) => records.find((r) => r.scriptHash.equals(hash)) ?? null),
    $getRank: jest.fn(async (record: BalanceRecord) => records.indexOf(record) + 1),
  };
}

function setup(repo = fakeRepository(), topN = 2) {
  const handlers: Record<string, (req: any, res: any) => Promise<void>> = {};
  const app: any = {};
  app.get = (route: string, handler) => { handlers[route] = handler; return app; };
  new SupplyDistributionRoutes(repo as unknown as SupplyDistributionRepository, topN, supplyNetwork('mainnet'), 6).initRoutes(app);
  const call = async (route: string, query: Record<string, string> = {}, params: Record<string, string> = {}) => {
    const res: any = { statusCode: 200, headers: {}, headersSent: false };
    res.status = (status: number) => { res.statusCode = status; return res; };
    res.setHeader = (name: string, value: unknown) => { res.headers[name] = value; return res; };
    res.json = (body: unknown) => { res.body = body; return res; };
    await handlers['/api/v1/supply/' + route]({ query, params }, res);
    return res;
  };
  return { call, repo };
}

describe('supply distribution routes', () => {
  test('distribution reports totals, issuance and status', async () => {
    const { call } = setup();
    const res = await call('distribution');
    expect(res.statusCode).toBe(200);
    expect(res.headers['Cache-Control']).toBe('public, max-age=10');
    expect(res.body).toMatchObject({
      status: 'ready', height: 900000, confirmations: 6, totalAmount: 1_000_000, nonZeroScriptCount: 3, zeroBalanceScripts: 1,
      maxSupply: 2_100_000_000_000_000,
    });
    expect(res.body.issuedAmount).toBeGreaterThan(0);
    expect(res.body.buckets).toHaveLength(10);
    expect(res.body.tiers).toEqual([
      { fromRank: 1, toRank: 2, scriptCount: 2, amount: 900_000 },
      { fromRank: 3, toRank: null, scriptCount: 1, amount: 100_000 },
    ]);
  });

  test('holder tiers are computed once per data height', async () => {
    const repo = fakeRepository();
    const { call } = setup(repo);
    await call('distribution');
    await call('distribution');
    expect(repo.$getTopBalanceAmounts).toHaveBeenCalledTimes(1);
    expect(repo.$getTopBalanceAmounts).toHaveBeenCalledWith(2);
    repo.$getState.mockResolvedValue({ ...state, height: state.height + 1, hash: 'cd'.repeat(32) });
    await call('distribution');
    expect(repo.$getTopBalanceAmounts).toHaveBeenCalledTimes(2);
  });

  test('returns 404 before the first bootstrap', async () => {
    const { call } = setup(fakeRepository(null));
    expect((await call('distribution')).statusCode).toBe(404);
    expect((await call('top-addresses')).body).toEqual({ error: 'no_data' });
  });

  test('top addresses are capped at TOP_N and describe scripts', async () => {
    const { call, repo } = setup();
    const res = await call('top-addresses', { page: '1', limit: '100' });
    expect(repo.$getTopBalances).toHaveBeenCalledWith(0, 2);
    expect(res.body).toMatchObject({ total: 2, page: 1, limit: 100 });
    expect(res.body.rows).toEqual([
      { rank: 1, address: BLOCK1_PUBKEY, type: 'p2pk', balance: 600_000, utxoCount: 1 },
      { rank: 2, address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', type: 'v0_p2wpkh', balance: 300_000, utxoCount: 2 },
    ]);
    const bigTop = setup(fakeRepository(), 3);
    const nonstandard = (await bigTop.call('top-addresses', { page: '3', limit: '1' })).body.rows[0];
    expect(nonstandard).toMatchObject({ rank: 3, address: null, type: 'nonstandard', scriptTruncated: true });
    expect(nonstandard.script).toHaveLength(128);
  });

  test('rejects out-of-range pagination', async () => {
    const { call } = setup();
    const queries: Record<string, string>[] = [{ limit: '0' }, { limit: '101' }, { page: '0' }, { page: '1.5' }, { page: '2', limit: '2' }];
    for (const query of queries) {
      expect((await call('top-addresses', query)).statusCode).toBe(400);
    }
  });

  test('ranks an address only inside the top N', async () => {
    const { call } = setup();
    const ranked = await call('address/:address', {}, { address: 'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4' });
    expect(ranked.body).toMatchObject({ rank: 2, topN: 2, balance: 300_000, share: 0.3, height: 900000 });
    const pubkey = await call('address/:address', {}, { address: BLOCK1_PUBKEY });
    expect(pubkey.body.rank).toBe(1);
    const unknown = await call('address/:address', {}, { address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.body.error).toBe('not_ranked');
    const invalid = await call('address/:address', {}, { address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx' });
    expect(invalid.statusCode).toBe(400);
  });

  test('addresses below the top-N threshold are not ranked', async () => {
    const repo = fakeRepository();
    repo.$getBalance.mockResolvedValue(records[2]);
    const { call } = setup(repo, 2);
    const res = await call('address/:address', {}, { address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' });
    expect(res.statusCode).toBe(404);
    expect(repo.$getRank).not.toHaveBeenCalled();
  });
});

describe('supply bootstrap orchestration', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supply-bootstrap-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function deps(overrides = {}) {
    const snapshotDir = path.join(dir, 'snapshots');
    const workDir = path.join(dir, 'work', 'supply-bootstrap');
    fs.mkdirSync(snapshotDir, { recursive: true });
    const dumpClient = {
      dumpTxOutSet: jest.fn(async (file: string) => {
        fs.writeFileSync(file, 'snapshot');
        return { coins_written: 5, base_hash: 'cd'.repeat(32), base_height: 123, path: file, txoutset_hash: '', nchaintx: 0 };
      }),
    };
    const repository = { $finishBootstrap: jest.fn(async () => state) };
    const runWorker = jest.fn(async () => {
      fs.mkdirSync(workDir, { recursive: true });
      fs.writeFileSync(path.join(workDir, 'partition-007.bin'), 'x');
      return { header: { version: 2, networkMagic: '', baseBlockHash: 'cd'.repeat(32), coinsCount: 5 }, totals: emptyTotals() };
    });
    return {
      rpc: { getBlockchainInfo: jest.fn(async () => ({ blocks: 123, headers: 123, initialblockdownload: false })) },
      dumpClient, repository: repository as unknown as SupplyDistributionRepository, runWorker, snapshotDir, workDir, ...overrides,
    };
  }

  test('dumps, aggregates, swaps in the table and removes temporary files', async () => {
    const d = deps();
    fs.writeFileSync(path.join(d.snapshotDir, `${SNAPSHOT_PREFIX}old.dat.incomplete`), 'stale');
    fs.writeFileSync(path.join(d.snapshotDir, 'keep.txt'), 'other');
    await new SupplyBootstrap(d).$run();
    expect(d.dumpClient.dumpTxOutSet).toHaveBeenCalledWith(expect.stringContaining(SNAPSHOT_PREFIX), 'latest');
    expect(d.runWorker).toHaveBeenCalledWith(expect.objectContaining({ expectedCoins: 5, expectedBaseHash: 'cd'.repeat(32) }));
    expect((d.repository as any).$finishBootstrap).toHaveBeenCalledWith('supply_balances_new', expect.anything(),
      { height: 123, hash: 'cd'.repeat(32) });
    expect(fs.readdirSync(d.snapshotDir)).toEqual(['keep.txt']);
    expect(fs.existsSync(d.workDir)).toBe(false);
  });

  test('refuses to dump while the node is syncing and cleans up after failures', async () => {
    const syncing = deps({ rpc: { getBlockchainInfo: async () => ({ blocks: 1, headers: 9, initialblockdownload: true }) } });
    await expect(new SupplyBootstrap(syncing).$run()).rejects.toThrow(/not fully synced/);
    expect(syncing.dumpClient.dumpTxOutSet).not.toHaveBeenCalled();

    const failing = deps();
    failing.runWorker.mockRejectedValueOnce(new Error('parse failed'));
    await expect(new SupplyBootstrap(failing).$run()).rejects.toThrow('parse failed');
    expect(fs.readdirSync(failing.snapshotDir)).toEqual([]);
    expect((failing.repository as any).$finishBootstrap).not.toHaveBeenCalled();
  });

  test('cleanup only removes its own files', () => {
    const work = path.join(dir, 'w');
    fs.mkdirSync(work);
    fs.writeFileSync(path.join(work, 'partition-001.bin'), '');
    fs.writeFileSync(path.join(work, 'unrelated.bin'), '');
    cleanupSupplyFiles(path.join(dir, 'missing'), work);
    expect(fs.readdirSync(work)).toEqual(['unrelated.bin']);
  });
});

describe('supply database helpers', () => {
  test('DB can target the supply database without changing the default pool', () => {
    expect((new DB({ database: 'mempool_supply' }) as any).poolConfig.database).toBe('mempool_supply');
    expect((new DB() as any).poolConfig.database).toBe('mempool');
  });

  test('batch inserter bounds rows per statement and surfaces failures', async () => {
    const batches: number[] = [];
    const db = { query: jest.fn(async (_sql: string, params: any[]) => { batches.push(params[0].length); return [{}, []]; }) };
    const inserter = createBatchInserter(db as unknown as DB, 'supply_balances_new');
    const row = { scriptHash: Buffer.alloc(32), script: Buffer.alloc(22), balance: 1, utxoCount: 1 };
    await inserter.add(Array(12001).fill(row));
    await inserter.finish();
    expect(batches).toEqual([5000, 5000, 2001]);

    const failing = { query: jest.fn(async () => { throw new Error('deadlock'); }) };
    const broken = createBatchInserter(failing as unknown as DB, 't');
    await broken.add([row]);
    await expect(broken.finish()).rejects.toThrow('deadlock');
  });
});
