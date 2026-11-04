import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createConnection } from 'mysql2/promise';
import config from '../config';
import { DB } from '../database';
import { $initializeSupplySchema } from '../api/supply/supply-database';
import { $runBootstrapWorker, STAGING_TABLE } from '../api/supply/supply-bootstrap-worker';
import { buildBlockDelta } from '../api/supply/supply-delta';
import { SupplyDistributionRoutes } from '../api/supply/supply-distribution.routes';
import { describeScript, scriptHash, supplyNetwork } from '../api/supply/supply-script';
import { SupplyDistributionRepository, SupplyInconsistencyError, SupplyStateConflictError } from '../repositories/SupplyDistributionRepository';
import { TEST_BASE_HASH, TestCoin, buildSnapshot, p2pkUncompressed, p2pkh, p2wpkh, testOutput, testTx } from '../__tests__/api/supply-test-utils';
import { waitForDatabase } from './test-helpers';

const SUPPLY_DATABASE = 'mempool_supply_test';
const ROOT = { host: config.DATABASE.HOST, port: config.DATABASE.PORT, user: 'root', password: 'admin' };

/** Deterministic synthetic UTXO set: many scripts with several UTXOs each, across every compression type. */
function syntheticCoins(): TestCoin[][] {
  const groups: TestCoin[][] = [[{ vout: 0, height: 1, coinbase: true, amount: 5_000_000_000, script: p2pkUncompressed() }]];
  let seed = 7;
  const next = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
  for (let tx = 0; tx < 6000; tx++) {
    const coins: TestCoin[] = [];
    for (let vout = 0; vout < 5; vout++) {
      const owner = next() % 9000;
      const script = owner % 3 === 0 ? p2wpkh(owner % 256) : owner % 3 === 1
        ? Buffer.concat([Buffer.from('76a914', 'hex'), Buffer.alloc(18, owner % 256), Buffer.from([owner >> 8, owner & 255]), Buffer.from('88ac', 'hex')])
        : Buffer.concat([Buffer.from('0020', 'hex'), Buffer.alloc(30, 0x5a), Buffer.from([owner >> 8, owner & 255])]);
      coins.push({ vout, height: 100_000 + tx, amount: next() % 3 === 0 ? 0 : next() % 2_000_000_000, script });
    }
    groups.push(coins);
  }
  return groups;
}

async function tableDump(db: DB): Promise<unknown> {
  const [balances] = await db.query<any[]>('SELECT HEX(script_hash) h, balance, utxo_count FROM supply_balances ORDER BY script_hash');
  const [buckets] = await db.query<any[]>('SELECT * FROM supply_buckets ORDER BY bucket');
  const [state] = await db.query<any[]>('SELECT height, hash, total_amount, utxo_count, script_count, zero_balance_scripts FROM supply_state');
  return JSON.parse(JSON.stringify({ balances, buckets, state }));
}

describe('Supply distribution against MariaDB', () => {
  let db: DB;
  let repo: SupplyDistributionRepository;
  let dir: string;
  const groups = syntheticCoins();
  const coins = groups.flat();

  beforeAll(async () => {
    await waitForDatabase();
    const root = await createConnection(ROOT);
    await root.query(`DROP DATABASE IF EXISTS ${SUPPLY_DATABASE}`);
    await root.query(`CREATE DATABASE ${SUPPLY_DATABASE}`);
    await root.query(`GRANT ALL ON ${SUPPLY_DATABASE}.* TO '${config.DATABASE.USERNAME}'@'%'`);
    await root.end();
    db = new DB({ database: SUPPLY_DATABASE });
    repo = new SupplyDistributionRepository(db);
    await $initializeSupplySchema(db);
    await $initializeSupplySchema(db);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supply-it-'));
  }, 120000);

  afterAll(async () => {
    await db?.close();
    fs.rmSync(dir, { recursive: true, force: true });
    const root = await createConnection(ROOT);
    await root.query(`DROP DATABASE IF EXISTS ${SUPPLY_DATABASE}`);
    await root.end();
  });

  const snapshotCoins = (snapshot: Buffer): number => Number(snapshot.readBigUInt64LE(5 + 2 + 4 + 32));

  async function bootstrap(snapshot: Buffer, height: number): Promise<void> {
    const snapshotPath = path.join(dir, `snapshot-${height}.dat`);
    fs.writeFileSync(snapshotPath, snapshot);
    const result = await $runBootstrapWorker({
      snapshotPath, tempDir: path.join(dir, 'work'), database: SUPPLY_DATABASE, expectedBaseHash: TEST_BASE_HASH,
      expectedCoins: snapshotCoins(snapshot), indexTimeout: 600000,
    }, () => undefined, new DB({ database: SUPPLY_DATABASE }));
    await repo.$finishBootstrap(STAGING_TABLE, result.totals, { height, hash: TEST_BASE_HASH });
  }

  test('bootstrap loads one row per script with matching totals and index', async () => {
    await bootstrap(buildSnapshot(groups), 900000);
    const [[sums]] = await db.query<any[]>('SELECT COUNT(*) n, SUM(balance) amount, SUM(utxo_count) utxos FROM supply_balances') as any;
    const expectedAmount = coins.reduce((sum, c) => sum + c.amount, 0);
    const distinct = new Set(coins.map((c) => c.script.toString('hex'))).size;
    expect(Number(sums.n)).toBe(distinct);
    expect(Number(sums.amount)).toBe(expectedAmount);
    expect(Number(sums.utxos)).toBe(coins.length);
    const state = await repo.$getState();
    expect(state).toMatchObject({ height: 900000, status: 'bootstrapping', totalAmount: expectedAmount, utxoCount: coins.length, scriptCount: distinct });
    const buckets = await repo.$getBuckets();
    expect(buckets.reduce((s, b) => s + b.scriptCount, 0)).toBe(distinct);
    expect(buckets.reduce((s, b) => s + b.amount, 0)).toBe(expectedAmount);
    const [indexes] = await db.query<any[]>("SHOW INDEX FROM supply_balances WHERE Key_name = 'balance'");
    expect(indexes.length).toBe(2);
    const satoshi = await repo.$getBalance(scriptHash(p2pkUncompressed()));
    expect(satoshi).toMatchObject({ balance: 5_000_000_000, utxoCount: 1 });
    expect(satoshi?.script).toEqual(p2pkUncompressed());
  }, 120000);

  test('applying and undoing a block is atomic and exact', async () => {
    const before = await tableDump(db);
    const state = (await repo.$getState())!;
    const spent = coins.find((c) => c.amount > 0 && c.script[0] === 0x00 && c.script[1] === 0x14)!;
    const block = [
      testTx('cb', ['coinbase'], [testOutput(p2pkh(0x01), 312_500_000)]),
      testTx('t', [testOutput(spent.script, spent.amount), testOutput(p2pkUncompressed(), 5_000_000_000)],
        [testOutput(p2wpkh(0xfe), spent.amount + 4_999_990_000)]),
    ];
    const next = { height: 900001, hash: 'ee'.repeat(32) };
    const applied = await repo.$applyDelta(state, next, buildBlockDelta(block));
    expect(applied).toMatchObject({ height: 900001, utxoCount: state.utxoCount, totalAmount: state.totalAmount + 312_500_000 - 10_000 });
    expect(await repo.$getBalance(scriptHash(p2pkUncompressed()))).toBeNull();
    expect((await repo.$getBalance(scriptHash(p2wpkh(0xfe))))?.balance).toBe(spent.amount + 4_999_990_000);

    await expect(repo.$applyDelta(state, next, [])).rejects.toThrow(SupplyStateConflictError);
    const overspend = buildBlockDelta([testTx('x', [testOutput(p2pkh(0x01), 312_500_001)], [])]);
    await expect(repo.$applyDelta(next, { height: 900002, hash: 'ff'.repeat(32) }, overspend)).rejects.toThrow(SupplyInconsistencyError);
    expect((await repo.$getState())?.height).toBe(900001);

    await repo.$applyDelta(next, { height: state.height, hash: state.hash }, buildBlockDelta(block, -1));
    expect(await tableDump(db)).toEqual(before);
  }, 120000);

  test('routes rank addresses in balance order', async () => {
    const routes = new SupplyDistributionRoutes(repo, 50, supplyNetwork('mainnet'), 6);
    const handlers: Record<string, (req: any, res: any) => Promise<void>> = {};
    const app: any = { get: (p: string, h) => { handlers[p.split('/').pop()!] = h; return app; } };
    routes.initRoutes(app);
    const call = async (name: string, req: any): Promise<any> => {
      const res: any = { statusCode: 200, setHeader: () => res, status: (s: number) => { res.statusCode = s; return res; } };
      res.json = (body: unknown) => { res.body = body; return res; };
      await handlers[name](req, res);
      return res;
    };
    const top = (await call('top-addresses', { query: { page: '1', limit: '50' } })).body.rows;
    expect(top).toHaveLength(50);
    for (let i = 1; i < top.length; i++) {
      expect(top[i - 1].balance).toBeGreaterThanOrEqual(top[i].balance);
    }
    const twentieth = top[19];
    const ranked = await call(':address', { params: { address: twentieth.address } });
    expect(ranked.body.rank).toBe(20);
    const [[outside]] = await db.query<any[]>('SELECT script FROM supply_balances ORDER BY balance ASC LIMIT 1') as any;
    const notRanked = await call(':address', { params: { address: describeScript(outside.script, supplyNetwork('mainnet')).address } });
    expect(notRanked.statusCode).toBe(404);

    const distribution = (await call('distribution', { query: {} })).body;
    const tiers = distribution.tiers;
    expect(tiers.map((t) => [t.fromRank, t.toRank])).toEqual([[1, 10], [11, 50], [51, null]]);
    expect(tiers[0].amount).toBe(top.slice(0, 10).reduce((sum, row) => sum + row.balance, 0));
    expect(tiers.reduce((sum, t) => sum + t.amount, 0)).toBe(distribution.totalAmount);
    expect(tiers.reduce((sum, t) => sum + t.scriptCount, 0)).toBe(distribution.nonZeroScriptCount);
  }, 120000);

  test('bootstrapping again replaces the table', async () => {
    await bootstrap(buildSnapshot([[{ vout: 0, height: 5, amount: 42, script: p2pkh(0x42) }]]), 900010);
    expect(await repo.$getState()).toMatchObject({ height: 900010, scriptCount: 1, totalAmount: 42, utxoCount: 1 });
    const [tables] = await db.query<any[]>("SHOW TABLES LIKE 'supply_balances%'");
    expect(tables.length).toBe(1);
  }, 120000);
});
