import BitcoinApi from '../../api/bitcoin/bitcoin-api';
import ElectrumApi from '../../api/bitcoin/electrum-api';
import mempool from '../../api/mempool';
import logger from '../../logger';

jest.mock('../../api/blocks', () => ({ getCurrentBlockHeight: () => 100 }));
jest.mock('../../api/transaction-utils', () => ({ convertScriptSigAsm: () => '' }));

const txids = Array.from({ length: 8 }, (_, i) => String(i).padStart(64, '0'));
const metadata = Object.fromEntries(txids.map(txid => [txid, { fees: { base: 0.00001234 } }]));
const rawTransaction = (txid: string) => ({ txid, version: 2, locktime: 0, size: 100, weight: 400, vin: [], vout: [] });

describe('Bitcoin RPC cold-start fee metadata', () => {
  let client: { getRawMemPool: jest.Mock; getRawTransaction: jest.Mock; getMempoolEntry: jest.Mock };
  let api: BitcoinApi;

  beforeEach(() => {
    jest.clearAllMocks();
    (mempool as any).isInSync = jest.fn(() => false);
    (mempool as any).getMempool = () => ({});
    client = {
      getRawMemPool: jest.fn().mockResolvedValue(metadata),
      getRawTransaction: jest.fn(async txid => rawTransaction(txid)),
      getMempoolEntry: jest.fn().mockResolvedValue({ fees: { base: 0.00005678 } }),
    };
    api = new BitcoinApi(client);
  });

  afterEach(() => jest.useRealTimers());

  test.each(['core', 'electrum'])('shares initialization across 8 concurrent %s requests and retains fee data', async mode => {
    if (mode === 'electrum') { api = new ElectrumApi(client, {}); }
    let resolve!: (value: typeof metadata) => void;
    client.getRawMemPool.mockImplementation(() => new Promise(r => { resolve = r; }));
    const requests = txids.map(txid => api.$getRawTransaction(txid));
    for (let i = 0; i < 4; i++) { await Promise.resolve(); }
    expect(client.getRawMemPool).toHaveBeenCalledTimes(1);
    expect(client.getRawMemPool).toHaveBeenCalledWith(true);
    resolve(metadata);
    const results = await Promise.all(requests);
    expect(results.map(tx => tx.fee)).toEqual(Array(8).fill(1234));
    expect((api as any).rawMempoolCache).toBe(metadata);
    expect((api as any).rawMempoolCachePromise).toBeNull();
    await api.$getRawTransaction(txids[0]);
    expect(client.getRawMemPool).toHaveBeenCalledTimes(1);
    expect(client.getMempoolEntry).not.toHaveBeenCalled();
  });

  test('propagates a shared rejection to every waiter and retries successfully', async () => {
    const error = Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
    client.getRawMemPool.mockRejectedValueOnce(error).mockResolvedValue(metadata);
    const results = await Promise.allSettled(txids.map(txid => api.$getRawTransaction(txid)));
    expect(client.getRawMemPool).toHaveBeenCalledTimes(1);
    expect(results).toEqual(Array(8).fill({ status: 'rejected', reason: error }));
    expect((api as any).rawMempoolCache).toBeNull();
    expect((api as any).rawMempoolCachePromise).toBeNull();
    expect((await api.$getRawTransaction(txids[0])).fee).toBe(1234);
    expect(client.getRawMemPool).toHaveBeenCalledTimes(2);
  });

  test('initializes independent caches for separate API instances', async () => {
    const second = new BitcoinApi(client);
    const results = await Promise.all([
      ...txids.map(id => api.$getRawTransaction(id)),
      ...txids.map(id => second.$getRawTransaction(id)),
    ]);
    expect(results).toHaveLength(16);
    expect(client.getRawMemPool).toHaveBeenCalledTimes(2);
  });

  test('uses entry fallback for transactions absent from the snapshot', async () => {
    expect((await api.$getRawTransaction('missing')).fee).toBe(5678);
    expect(client.getMempoolEntry).toHaveBeenCalledWith('missing');
  });

  test('avoids verbose initialization when synchronized', async () => {
    (mempool.isInSync as jest.Mock).mockReturnValue(true);
    expect((await api.$getRawTransaction(txids[0])).fee).toBe(5678);
    expect(client.getRawMemPool).not.toHaveBeenCalled();
  });

  test('does not initialize fee metadata for confirmed transactions', async () => {
    client.getRawTransaction.mockResolvedValue({ ...rawTransaction(txids[0]), confirmations: 1 });
    expect((await api.$getRawTransaction(txids[0])).status.confirmed).toBe(true);
    expect(client.getRawMemPool).not.toHaveBeenCalled();
  });

  test.each([false, true])('warns on a slow raw RPC while preserving success or failure (reject=%s)', async reject => {
    jest.useFakeTimers();
    const error = Object.assign(new Error('ESOCKETTIMEDOUT'), { code: 'ESOCKETTIMEDOUT' });
    client.getRawTransaction.mockImplementation(() => new Promise((resolve, fail) => {
      setTimeout(() => reject ? fail(error) : resolve(rawTransaction(txids[0])), 5001);
    }));
    const result = api.$getRawTransaction(txids[0]);
    const assertion = reject ? expect(result).rejects.toBe(error) : expect(result).resolves.toMatchObject({ fee: 1234 });
    await jest.advanceTimersByTimeAsync(5001);
    await assertion;
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/getrawtransaction.*duration=5001ms.*threshold=5000ms/));
  });
});
