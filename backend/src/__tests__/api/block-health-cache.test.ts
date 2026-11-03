import config from '../../config';
import { Common } from '../../api/common';
import blocks from '../../api/blocks';
import { TransactionFlags } from '../../mempool.interfaces';
import audits from '../../repositories/BlocksAuditsRepository';
import summaries from '../../repositories/BlocksSummariesRepository';
import bitcoinApi from '../../api/bitcoin/bitcoin-api-factory';
import transactionUtils from '../../api/transaction-utils';

jest.mock('../../api/bitcoin/bitcoin-api-factory', () => ({ $getTxsForBlock: jest.fn() }));
jest.mock('../../api/bitcoin/bitcoin-client', () => ({}));
jest.mock('../../api/bitcoin/bitcoin-second-client', () => ({}));
jest.mock('../../api/backend-info', () => ({}));
jest.mock('../../api/transaction-utils', () => ({ extendTransaction: jest.fn(tx => tx) }));
jest.mock('../../api/disk-cache', () => ({}));
jest.mock('../../api/redis-cache', () => ({}));
jest.mock('../../api/websocket-handler', () => ({}));
jest.mock('../../api/mempool-blocks', () => ({}));
jest.mock('../../api/block-processor', () => ({}));
jest.mock('../../api/chain-tips', () => ({}));
jest.mock('../../api/pools-parser', () => ({}));
jest.mock('../../api/mining/mining', () => ({}));
jest.mock('../../api/statistics/statistics', () => ({}));
jest.mock('../../tasks/price-updater', () => ({}));
jest.mock('../../indexer', () => ({}));
jest.mock('../../database', () => ({}));
jest.mock('../../repositories/BlocksAuditsRepository', () => ({
  $getBlockAuditScore: jest.fn(), $saveAudit: jest.fn(), $setHealth: jest.fn(),
}));
jest.mock('../../repositories/BlocksSummariesRepository', () => ({
  $getByBlockId: jest.fn(), $saveTransactions: jest.fn(),
}));

describe('Health classification cache upgrades', () => {
  const previousAudit = config.MEMPOOL.AUDIT;
  beforeEach(() => { config.MEMPOOL.AUDIT = true; jest.clearAllMocks(); });
  afterEach(() => { config.MEMPOOL.AUDIT = previousAudit; jest.restoreAllMocks(); });
  const summary = () => ({ id: 'block', height: 100, version: Common.BLOCKS_SUMMARY_CLASSIFICATION_VERSION, transactions: [
    { txid: 'coinbase', vsize: 100, flags: 0 },
    { txid: 'normal', vsize: 200, flags: Number(TransactionFlags.op_return) },
  ] });
  const block = () => ({ id: 'block', height: 100, version: 0, timestamp: 1,
    extras: { matchRate: 33.33, expectedFees: null, expectedWeight: null } });

  test('refreshes restored tip Health from a current summary', () => {
    const cache = new (blocks.constructor as any)();
    cache.setBlocks([block()]);
    cache.setBlockSummaries([summary()]);
    expect(cache.getBlocks()[0].extras.matchRate).toBe(100);
  });
  test('does not retain scores restored alongside obsolete classifications', () => {
    const cache = new (blocks.constructor as any)();
    cache.setBlocks([block()]);
    cache.setBlockSummaries([{ ...summary(), version: 5 }]);
    expect(cache.getBlocks()[0].extras.matchRate).toBeNull();
  });
  test('block lookup rebuilds a stale summary instead of serving the stored old score', async () => {
    const cache = new (blocks.constructor as any)();
    cache.setBlocks([block()]);
    cache.setBlockSummaries([{ ...summary(), version: 5 }]);
    const classify = jest.spyOn(cache, '$getStrippedBlockTransactions').mockResolvedValue(summary().transactions);
    (audits.$getBlockAuditScore as jest.Mock).mockResolvedValue({ matchRate: 33.33 });
    expect((await cache.$getBlock('block')).extras.matchRate).toBe(100);
    expect(classify).toHaveBeenCalled();
  });
  test('block lists refresh obsolete scores too', async () => {
    const cache = new (blocks.constructor as any)();
    cache.setBlocks([block()]);
    cache.currentBlockHeight = 100;
    cache.setBlockSummaries([{ ...summary(), version: 5 }]);
    jest.spyOn(cache, '$getStrippedBlockTransactions').mockResolvedValue(summary().transactions);
    const result = await cache.$getBlocks(100, 1);
    expect(result[0].extras.matchRate).toBe(100);
  });
  test('does not return an obsolete score when reclassification fails', async () => {
    const cache = new (blocks.constructor as any)();
    cache.setBlocks([block()]);
    jest.spyOn(cache, '$getStrippedBlockTransactions').mockRejectedValue(new Error('unavailable'));
    expect((await cache.$getBlock('block')).extras.matchRate).toBeNull();
  });
  test('rebuilding a summary refreshes persisted Health without replacing audit metadata', async () => {
    const cache = new (blocks.constructor as any)();
    jest.spyOn(Common, 'blocksSummariesIndexingEnabled').mockReturnValue(true);
    jest.spyOn(Common, 'auditIndexingEnabled').mockReturnValue(true);
    (summaries.$getByBlockId as jest.Mock).mockResolvedValue({ ...summary(), version: 5 });
    (bitcoinApi.$getTxsForBlock as jest.Mock).mockResolvedValue([]);
    jest.spyOn(cache, 'summarizeBlockTransactions').mockReturnValue(summary());
    await cache.$getStrippedBlockTransactions('block', false, false, undefined, 100);
    expect(transactionUtils.extendTransaction).not.toHaveBeenCalled();
    expect((audits as any).$setHealth).toHaveBeenCalledWith('block', 100);
  });
});
