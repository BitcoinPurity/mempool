import { Common } from '../../api/common';
import { TransactionFlags } from '../../mempool.interfaces';
import blocks from '../../api/blocks';
import reducedData from '../../api/bip110-deployment';

jest.mock('../../api/bitcoin/bitcoin-api-factory', () => ({}));
jest.mock('../../api/bitcoin/bitcoin-client', () => ({}));
jest.mock('../../api/bitcoin/bitcoin-second-client', () => ({}));
jest.mock('../../api/backend-info', () => ({}));
jest.mock('../../api/transaction-utils', () => ({}));
jest.mock('../../api/disk-cache', () => ({}));
jest.mock('../../api/redis-cache', () => ({}));
jest.mock('../../api/websocket-handler', () => ({}));
jest.mock('../../api/mempool-blocks', () => ({}));
jest.mock('../../api/block-processor', () => ({}));
jest.mock('../../api/audit', () => ({}));
jest.mock('../../api/chain-tips', () => ({}));
jest.mock('../../api/pools-parser', () => ({}));
jest.mock('../../api/mining/mining', () => ({}));
jest.mock('../../api/statistics/statistics', () => ({}));
jest.mock('../../tasks/price-updater', () => ({}));
jest.mock('../../indexer', () => ({}));
jest.mock('../../database', () => ({}));

describe('historical BIP-110 classification remains independent of permanent enforcement', () => {
  const tx = (vin: any[] = [], vout: any[] = []) => ({ txid: 'historical', vin, vout } as any);
  const control = 'c0' + '00'.repeat(32);
  const taproot = (witness: string[]) => ({ scriptsig: '', witness, prevout: { scriptpubkey_type: 'v1_p2tr' } });

  test.each([
    TransactionFlags.bip110_large_scriptpubkey, TransactionFlags.bip110_large_pushdata,
    TransactionFlags.bip110_undefined_witness, TransactionFlags.bip110_taproot_annex,
    TransactionFlags.bip110_large_control_block, TransactionFlags.bip110_op_success,
    TransactionFlags.bip110_op_if_notif,
  ])('keeps violation mask flag %s', flag => {
    expect(Common.hasAnyBIP110Violation(flag)).toBe(true);
  });

  test.each([[34, false], [35, true]])('classifies a %i-byte output independently of tip height', (length, violates) => {
    const transaction = tx([], [{ scriptpubkey: '00'.repeat(length), scriptpubkey_type: 'unknown' }]);
    for (const height of [961636, 961637, 2000000]) {
      reducedData.getStatus(height);
      expect(Common.hasAnyBIP110Violation(Common.getBIP110Flags(transaction))).toBe(violates);
    }
  });

  test.each([[83, false], [84, true]])('keeps the OP_RETURN boundary at %i bytes', (length, violates) => {
    expect(Common.hasAnyBIP110Violation(Common.getBIP110Flags(tx([], [
      { scriptpubkey: '6a' + '00'.repeat(length - 1), scriptpubkey_type: 'op_return' },
    ])))).toBe(violates);
  });

  test('keeps witness arguments, annex, control depth and tapscript violations', () => {
    const cases: [any, bigint][] = [
      [{ scriptsig: '', witness: ['00'.repeat(257), '51'], prevout: { scriptpubkey_type: 'v0_p2wsh' } }, TransactionFlags.bip110_large_pushdata],
      [taproot(['00'.repeat(64), '50']), TransactionFlags.bip110_taproot_annex],
      [taproot(['51', control + '00'.repeat(256)]), TransactionFlags.bip110_large_control_block],
      [taproot(['51', 'c2' + '00'.repeat(32)]), TransactionFlags.bip110_undefined_witness],
      [taproot(['50', control]), TransactionFlags.bip110_op_success],
      [taproot(['51635168', control]), TransactionFlags.bip110_op_if_notif],
    ];
    for (const [input, expected] of cases) {
      expect(Common.getBIP110Flags(tx([input])) & expected).toBe(expected);
    }
    expect(Common.getBIP110Flags(tx([taproot(['51', control])]))).toBe(0n);
  });

  test('restored classified summaries still populate block violation counts and weight', () => {
    const cache = new (blocks.constructor as any)();
    const block = { id: 'historical-block', height: 900000, extras: { bip110Signaling: true } };
    cache.setBlocks([block]);
    cache.setBlockSummaries([{
      id: block.id, height: block.height, version: Common.BLOCKS_SUMMARY_CLASSIFICATION_VERSION,
      transactions: [
        { txid: 'large-output', flags: Number(TransactionFlags.bip110_large_scriptpubkey), vsize: 100 },
        { txid: 'annex', flags: Number(TransactionFlags.bip110_taproot_annex), vsize: 200 },
        { txid: 'ordinary', flags: 0, vsize: 300 },
      ],
    }]);
    expect(cache.getBlocks()[0].extras).toEqual({ bip110Signaling: true, bip110ViolationCount: 2, bip110ViolationWeight: 1200 });
    expect(cache.getBlockSummaries()[0].transactions).toHaveLength(3);
  });
});
