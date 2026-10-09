import config from '../../config';
import mempool from '../../api/mempool';
import transactionUtils from '../../api/transaction-utils';
import redisCache from '../../api/redis-cache';
import rbfCache from '../../api/rbf-cache';
import blocks from '../../api/blocks';
import diskCache from '../../api/disk-cache';
import logger from '../../logger';
import * as fs from 'fs';

jest.unmock('../../api/mempool');
jest.mock('../../api/bitcoin/bitcoin-api-factory', () => ({ $getRawTransaction: jest.fn() }));
jest.mock('../../api/bitcoin/bitcoin-client', () => ({}));
jest.mock('../../api/bitcoin/bitcoin-second-client', () => ({}));
jest.mock('../../api/blocks', () => ({ getCurrentBlockHeight: () => 100, setBlocks: jest.fn(), setBlockSummaries: jest.fn() }));
jest.mock('../../api/services/acceleration', () => ({ getAccelerationDelta: () => [] }));
jest.mock('../../api/common', () => ({ Common: { isLiquid: () => false, stripTransaction: (tx: any) => tx, getTransactionFlags: () => 0 } }));
jest.mock('../../api/transaction-utils', () => ({
  $getMempoolTransactionsExtended: jest.fn(), extendMempoolTransaction: (tx: any) => tx,
  addInnerScriptsToVin: jest.fn(), txidToOrdering: () => 0,
}));
jest.mock('../../api/redis-cache', () => ({
  $addTransaction: jest.fn(), $flushTransactions: jest.fn(), $removeTransactions: jest.fn(),
}));
jest.mock('../../api/rbf-cache', () => ({ add: jest.fn(), updateCache: jest.fn(), load: jest.fn() }));
jest.mock('cluster', () => ({ isPrimary: false }));
jest.mock('fs', () => ({ ...jest.requireActual('fs'), existsSync: jest.fn(), readFileSync: jest.fn() }));

const tx = (txid: string) => ({ txid, vin: [], vout: [], vsize: 100, adjustedVsize: 100, sigops: 0, effectiveFeePerVsize: 1, order: 0 });
mempool.destroy();

describe('mempool synchronization and watchdog', () => {
  let pool: typeof mempool;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    config.MEMPOOL.BACKEND = 'electrum';
    config.MEMPOOL.CLUSTER_MEMPOOL = false;
    config.MEMPOOL.CACHE_ENABLED = true;
    config.MEMPOOL.USE_SECOND_NODE_FOR_MINFEE = false;
    config.REDIS.ENABLED = false;
    config.ESPLORA.BATCH_QUERY_BASE_SIZE = 1000;
    pool = new (mempool.constructor as any)();
    (transactionUtils.$getMempoolTransactionsExtended as jest.Mock).mockImplementation(async ids => ids.map(tx));
  });
  afterEach(() => {
    pool.destroy();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  const update = (ids: string[]) => pool.$updateMempool(ids, null, [], 100, 1000);

  test.each(['electrum', 'esplora'] as const)('fetches only 229 missing transactions from restored cache (%s)', async mode => {
    config.MEMPOOL.BACKEND = mode;
    const common = Array.from({ length: 32124 }, (_, i) => `cached-${i}`);
    const missing = Array.from({ length: 229 }, (_, i) => `missing-${i}`);
    await pool.$setMempool(Object.fromEntries([...common, 'stale'].map(id => [id, tx(id)])) as any);
    await update([...common, ...missing]);
    expect(transactionUtils.$getMempoolTransactionsExtended).toHaveBeenCalledTimes(1);
    expect(transactionUtils.$getMempoolTransactionsExtended).toHaveBeenCalledWith(missing, false, false, false);
    expect(pool.getMempool().stale).toBeUndefined();
    expect(Object.keys(pool.getMempool())).toHaveLength(32353);
    expect(pool.isInSync()).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/mode=incremental.*inSync=false.*core=32353 cached=32125 missing=229 stale=1/));
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/batch=1\/1 requested=229 started/));
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/batch=1\/1 fetched=229 failed=0 duration=/));
  });

  test('failed transactions stay missing and recover next cycle', async () => {
    (transactionUtils.$getMempoolTransactionsExtended as jest.Mock).mockResolvedValueOnce([tx('a')]);
    await update(['a', 'b']);
    expect(pool.isInSync()).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/fetched=1 failed=1/));
    await update(['a', 'b']);
    expect(transactionUtils.$getMempoolTransactionsExtended).toHaveBeenLastCalledWith(['b'], false, false, false);
    expect(pool.isInSync()).toBe(true);
  });

  test('cold start combines the actual BitcoinApi, limiter, conversion and sync with 229 missing transactions', async () => {
    const BitcoinApi = jest.requireActual('../../api/bitcoin/bitcoin-api').default;
    const utils = jest.requireActual('../../api/transaction-utils').default;
    const ids = Array.from({ length: 32354 }, (_, i) => i.toString(16).padStart(64, '0'));
    const current = ids.slice(1);
    const missing = current.slice(32124);
    await pool.$setMempool(Object.fromEntries(ids.slice(0, 32125).map(id => [id, tx(id)])) as any);
    jest.spyOn(mempool, 'getMempool').mockImplementation(() => pool.getMempool());
    jest.spyOn(mempool, 'isInSync').mockImplementation(() => pool.isInSync());
    const client = {
      getRawTransaction: jest.fn(async txid => ({ txid, version: 2, locktime: 0, weight: 400, size: 100, vin: [], vout: [] })),
      getRawMemPool: jest.fn().mockResolvedValue(Object.fromEntries(current.map(id => [id, { fees: { base: 0.00001234 } }]))),
      getMempoolEntry: jest.fn(),
    };
    const api = new BitcoinApi(client);
    jest.spyOn(jest.requireMock('../../api/bitcoin/bitcoin-api-factory'), '$getRawTransaction').mockImplementation(api.$getRawTransaction.bind(api));
    (transactionUtils.$getMempoolTransactionsExtended as jest.Mock).mockImplementation(utils.$getMempoolTransactionsExtended.bind(utils));
    await update(current);
    expect(client.getRawTransaction.mock.calls.map(call => call[0])).toEqual(missing);
    expect(client.getRawMemPool).toHaveBeenCalledTimes(1);
    expect(client.getMempoolEntry).not.toHaveBeenCalled();
    expect(pool.getMempool()[missing[0]].fee).toBe(1234);
    expect(pool.getMempool()[ids[0]]).toBeUndefined();
    expect(Object.keys(pool.getMempool())).toHaveLength(32353);
    expect(pool.isInSync()).toBe(true);
  });

  test('fetch exception propagates and leaves no stalled timer', async () => {
    const error = new Error('fetch failed');
    (transactionUtils.$getMempoolTransactionsExtended as jest.Mock).mockRejectedValueOnce(error);
    await expect(update(['a'])).rejects.toBe(error);
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(120001);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('$updateMempool stalled'));
    expect(logger.err).not.toHaveBeenCalledWith(expect.stringContaining('$updateMempool stalled'));
  });

  test('genuinely pending batch warns after 120 seconds then cleans up', async () => {
    let resolve!: (value: any[]) => void;
    (transactionUtils.$getMempoolTransactionsExtended as jest.Mock).mockImplementation(() => new Promise(r => { resolve = r; }));
    const pending = update(['a']);
    await jest.advanceTimersByTimeAsync(120001);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('$updateMempool stalled at "fetching transaction batch 1/1"'));
    resolve([tx('a')]);
    await pending;
    expect(jest.getTimerCount()).toBe(1);
  });

  test.each(['candidates', 'callback', 'redis'])('cleans watchdog on %s failures', async stage => {
    const error = new Error(stage);
    if (stage === 'candidates') { jest.spyOn(pool, 'getNextCandidates').mockImplementation(() => { throw error; }); }
    if (stage === 'callback') { pool.setAsyncMempoolChangedCallback(async () => { throw error; }); }
    if (stage === 'redis') {
      config.REDIS.ENABLED = true;
      (redisCache.$flushTransactions as jest.Mock).mockRejectedValueOnce(error);
    }
    await expect(update(['a'])).rejects.toBe(error);
    expect(jest.getTimerCount()).toBe(1);
  });

  test.each(['callback', 'redis'])('watchdog identifies pending %s', async stage => {
    let resolve!: () => void;
    const gate = new Promise<void>(r => { resolve = r; });
    if (stage === 'callback') { pool.setAsyncMempoolChangedCallback(() => gate); }
    else {
      config.REDIS.ENABLED = true;
      (redisCache.$flushTransactions as jest.Mock).mockReturnValueOnce(gate);
    }
    const pending = update(['a']);
    await jest.advanceTimersByTimeAsync(120001);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(stage === 'callback' ? 'running async mempool callback' : 'updating Redis cache'));
    resolve();
    await pending;
  });

  test.each([false, true])('preserves callbacks, evictions and Redis interactions (redis=%s)', async redis => {
    config.REDIS.ENABLED = redis;
    await pool.$setMempool({ stale: tx('stale') } as any);
    jest.clearAllMocks();
    const callback = jest.fn();
    const asyncCallback = jest.fn().mockResolvedValue(undefined);
    pool.setMempoolChangedCallback(callback);
    pool.setAsyncMempoolChangedCallback(asyncCallback);
    await update(['a']);
    expect(callback).toHaveBeenCalledWith(pool.getMempool(), [tx('a')], [[expect.objectContaining(tx('stale'))]], []);
    expect(asyncCallback).toHaveBeenCalledWith(pool.getMempool(), 1, [tx('a')], [[expect.objectContaining(tx('stale'))]], [], undefined);
    expect(redisCache.$addTransaction).toHaveBeenCalledTimes(redis ? 1 : 0);
    expect(redisCache.$flushTransactions).toHaveBeenCalledTimes(redis ? 1 : 0);
    expect(redisCache.$removeTransactions).toHaveBeenCalledTimes(redis ? 1 : 0);
    expect(rbfCache.updateCache).toHaveBeenCalledTimes(redis ? 1 : 0);
    if (redis) { expect(redisCache.$removeTransactions).toHaveBeenCalledWith(['stale']); }
    jest.clearAllMocks();
    await update(['a']);
    expect(transactionUtils.$getMempoolTransactionsExtended).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('[MEMPOOL_SYNC]'));
  });

  test('disk restoration retains blocks, RBF and spend map before incremental sync', async () => {
    const cachedTx = { ...tx('cached'), vin: [{ txid: 'parent', vout: 0 }] };
    const data = { cacheSchemaVersion: 3, network: config.MEMPOOL.NETWORK, mempool: {}, mempoolArray: [cachedTx], blocks: [], blockSummaries: [] };
    const rbf = { txs: [['old', { tx: 'old' }]], trees: [], expiring: [['old', 123]] };
    (fs.existsSync as jest.Mock).mockImplementation(path => path === config.MEMPOOL.CACHE_DIR + '/cache.json');
    (fs.readFileSync as jest.Mock).mockImplementation(path => JSON.stringify(String(path).endsWith('/rbfcache.json')
      ? { rbfCacheSchemaVersion: 1, network: config.MEMPOOL.NETWORK, rbf } : data));
    jest.spyOn(mempool, '$setMempool').mockImplementation(cache => pool.$setMempool(cache));
    jest.spyOn(mempool, 'getMempool').mockImplementation(() => pool.getMempool());
    jest.spyOn(mempool, 'getSpendMap').mockImplementation(() => pool.getSpendMap());
    await diskCache.$loadMempoolCache();
    expect(pool.getMempool().cached).toMatchObject(cachedTx);
    expect(blocks.setBlocks).toHaveBeenCalledWith([]);
    expect(rbfCache.load).toHaveBeenCalledWith({
      txs: [{ value: { tx: 'old' } }], trees: [], expiring: [{ key: 'old', value: 123 }], mempool: pool.getMempool(), spendMap: pool.getSpendMap(),
    });
    expect(pool.getSpendMap().get('parent:0')).toBe(pool.getMempool().cached);
    expect(pool.isInSync()).toBe(false);
    await update(['cached', 'new']);
    expect(transactionUtils.$getMempoolTransactionsExtended).toHaveBeenCalledWith(['new'], false, false, false);
    expect(pool.isInSync()).toBe(true);
  });

  test('RBF forwarding stays unchanged', () => {
    pool.handleRbfTransactions({ a: { replaced: [tx('old')], replacedBy: tx('new') } } as any);
    expect(rbfCache.add).toHaveBeenCalledWith([tx('old')], tx('new'));
  });

  test('removes a mined transaction absent from the next snapshot and reports it to callbacks', async () => {
    await update(['mined', 'remaining']);
    const mined = pool.getMempool().mined;
    const callback = jest.fn();
    pool.setMempoolChangedCallback(callback);
    await update(['remaining']);
    expect(pool.getMempool().mined).toBeUndefined();
    expect(transactionUtils.$getMempoolTransactionsExtended).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(pool.getMempool(), [], [[mined], []], []);
    expect(pool.isInSync()).toBe(true);
  });

  test('steady-state time budget still stops fetching after a slow batch and resumes next cycle', async () => {
    await update(['cached']);
    config.ESPLORA.BATCH_QUERY_BASE_SIZE = 1;
    (transactionUtils.$getMempoolTransactionsExtended as jest.Mock).mockImplementationOnce(ids => new Promise(resolve => {
      setTimeout(() => resolve(ids.map(tx)), 6000);
    }));
    const pending = update(['cached', 'a', 'b']);
    await jest.advanceTimersByTimeAsync(6000);
    await pending;
    expect(pool.getMempool().a).toBeDefined();
    expect(pool.getMempool().b).toBeUndefined();
    await update(['cached', 'a', 'b']);
    expect(pool.getMempool().b).toBeDefined();
  });

  test('large mempool clear protection still delays deletions', async () => {
    await pool.$setMempool(Object.fromEntries(Array.from({ length: 20001 }, (_, i) => [`tx-${i}`, tx(`tx-${i}`)])) as any);
    await update([]);
    expect(Object.keys(pool.getMempool())).toHaveLength(20001);
    expect(pool.isInSync()).toBe(false);
    await jest.advanceTimersByTimeAsync(config.MEMPOOL.CLEAR_PROTECTION_MINUTES * 60000);
    await update([]);
    expect(Object.keys(pool.getMempool())).toHaveLength(0);
    expect(pool.isInSync()).toBe(true);
  });
});
