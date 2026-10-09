import transactionUtils from '../../api/transaction-utils';
import bitcoinApi, { bitcoinCoreApi } from '../../api/bitcoin/bitcoin-api-factory';
import config from '../../config';
import logger from '../../logger';

jest.mock('../../api/bitcoin/bitcoin-api-factory', () => ({
  __esModule: true,
  default: { $getRawTransaction: jest.fn(), $getMempoolTransactions: jest.fn() },
  bitcoinCoreApi: { $getRawTransaction: jest.fn() },
}));
jest.mock('../../api/common', () => ({ Common: { isLiquid: () => false } }));

const tx = (txid: string) => ({ txid: txid.padStart(64, '0'), weight: 400, fee: 1234, sigops: 0, vin: [], vout: [], status: { confirmed: false } });

describe('transaction fetch diagnostics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    config.MEMPOOL.BACKEND = 'electrum';
  });
  afterEach(() => jest.useRealTimers());

  test('retains concurrency 8, successful ordering and failed transaction filtering', async () => {
    let active = 0;
    let maximum = 0;
    (bitcoinApi.$getRawTransaction as jest.Mock).mockImplementation(async txid => {
      active++;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active--;
      if (txid === '4') { throw Object.assign(new Error('secret must not be logged'), { code: 'ETIMEDOUT' }); }
      return tx(txid);
    });
    const ids = Array.from({ length: 20 }, (_, i) => String(i));
    const results = await transactionUtils.$getMempoolTransactionsExtended(ids);
    expect(maximum).toBe(8);
    expect(results.map(t => t.txid)).toEqual(ids.filter(id => id !== '4').map(id => id.padStart(64, '0')));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/requested=20 fetched=19 failed=1.*ETIMEDOUT/));
    expect(JSON.stringify((logger.warn as jest.Mock).mock.calls)).not.toContain('secret');
  });

  test('reports slow fetches, maximum and batch duration without changing results', async () => {
    jest.useFakeTimers();
    (bitcoinApi.$getRawTransaction as jest.Mock).mockImplementation(txid => new Promise(resolve => {
      setTimeout(() => resolve(tx(txid)), txid === '1' ? 6000 : 10);
    }));
    const result = transactionUtils.$getMempoolTransactionsExtended(['1', '2']);
    await jest.advanceTimersByTimeAsync(6000);
    expect(await result).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/slow=1.*max_fetch=6000ms.*duration=6000ms/));
  });

  test.each(['ETIMEDOUT', 'ESOCKETTIMEDOUT', -5])('reports error code %s while filtering failed transactions', async code => {
    (bitcoinApi.$getRawTransaction as jest.Mock).mockRejectedValue(Object.assign(new Error('private endpoint'), { code }));
    expect(await transactionUtils.$getMempoolTransactionsExtended(['1'])).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(String(code)));
  });

  test('retains Esplora bulk fetch behavior', async () => {
    config.MEMPOOL.BACKEND = 'esplora';
    (bitcoinApi.$getMempoolTransactions as jest.Mock).mockResolvedValue([tx('1'), tx('2')]);
    const results = await transactionUtils.$getMempoolTransactionsExtended(['1', '2']);
    expect(results.map(t => t.feePerVsize)).toEqual([12.34, 12.34]);
    expect(bitcoinApi.$getMempoolTransactions).toHaveBeenCalledWith(['1', '2']);
    expect(bitcoinApi.$getRawTransaction).not.toHaveBeenCalled();
  });

  test('forceCore still uses RPC when configured for Esplora', async () => {
    config.MEMPOOL.BACKEND = 'esplora';
    (bitcoinCoreApi.$getRawTransaction as jest.Mock).mockResolvedValue(tx('1'));
    expect(await transactionUtils.$getMempoolTransactionsExtended(['1'], false, false, true)).toHaveLength(1);
    expect(bitcoinCoreApi.$getRawTransaction).toHaveBeenCalledWith('1', false, false, false);
    expect(bitcoinApi.$getMempoolTransactions).not.toHaveBeenCalled();
  });
});
