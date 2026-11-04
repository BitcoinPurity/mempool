import BitcoinApi from '../../api/bitcoin/bitcoin-api';
import ElectrumApi from '../../api/bitcoin/electrum-api';
import { Common } from '../../api/common';
import transactionUtils from '../../api/transaction-utils';

jest.mock('../../api/blocks', () => ({ getCurrentBlockHeight: () => 100 }));
jest.mock('../../api/mempool', () => ({ getMempool: () => ({}) }));
jest.mock('../../api/transaction-utils', () => ({
  convertScriptSigAsm: () => '',
  addInnerScriptsToVin: jest.fn(),
}));

describe('Core block transactions with inline prevouts', () => {
  const output = { value: 1, n: 0, scriptPubKey: {
    hex: 'a914' + '11'.repeat(20) + '87', asm: 'OP_HASH160', type: 'scripthash', address: 'parent-address',
  } };
  const fixture = (): any => ({
    hash: 'block', height: 90, time: 1234, confirmations: 11,
    tx: [
      { txid: 'coinbase', version: 2, locktime: 0, size: 100, weight: 400,
        vin: [{ coinbase: '00', sequence: 0xffffffff }], vout: [output], confirmations: 11 },
      { txid: 'spend', version: 2, locktime: 0, size: 200, weight: 800,
        vin: [{ txid: 'parent', vout: 0, scriptSig: { hex: '00' }, sequence: 0xffffffff,
          prevout: { ...output, generated: false, height: 80 } }],
        vout: [{ ...output, value: 0.9999 }], confirmations: 11 },
    ],
  });
  const clientFor = (block = fixture()) => ({
    getBlock: jest.fn().mockResolvedValue(block),
    getRawTransaction: jest.fn().mockResolvedValue({
      ...fixture().tx[0], txid: 'parent', vout: [output],
    }),
  });

  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.restoreAllMocks());

  test.each(['core', 'electrum'])('%s gets complete transactions in one RPC without input lookups', async mode => {
    const client = clientFor();
    const api = mode === 'core' ? new BitcoinApi(client) : new ElectrumApi(client, {});
    const txs = await api.$getTxsForBlock('block');
    expect(client.getBlock).toHaveBeenCalledWith('block', 3);
    expect(client.getRawTransaction).not.toHaveBeenCalled();
    expect(txs.map(tx => tx.txid)).toEqual(['coinbase', 'spend']);
    expect(txs.map(tx => tx.fee)).toEqual([0, 10000]);
    expect(txs[1].vin[0].prevout).toMatchObject({
      value: 100000000, scriptpubkey: output.scriptPubKey.hex,
      scriptpubkey_address: 'parent-address', scriptpubkey_type: 'p2sh',
    });
    expect(transactionUtils.addInnerScriptsToVin).toHaveBeenCalledWith(txs[1].vin[0]);
    expect(txs.every(tx => tx.status.block_height === 90 && tx.status.block_time === 1234)).toBe(true);
  });

  test('retains the same transactions and fees when undo prevouts are absent', async () => {
    const inlineClient = clientFor();
    const inline = await new BitcoinApi(inlineClient).$getTxsForBlock('block');
    const legacyBlock = fixture();
    delete legacyBlock.tx[1].vin[0].prevout;
    const legacyClient = clientFor(legacyBlock);
    const legacy = await new BitcoinApi(legacyClient).$getTxsForBlock('block');
    expect(legacy).toEqual(inline);
    expect(legacyClient.getRawTransaction).toHaveBeenCalledTimes(1);
    expect(legacyClient.getRawTransaction).toHaveBeenCalledWith('parent', true);
  });

  test('fetches only missing inputs when inline prevouts are partial', async () => {
    const block = fixture();
    block.tx[1].vin.push({ txid: 'other-parent', vout: 0, sequence: 0xffffffff });
    const client = clientFor(block);
    const txs = await new BitcoinApi(client).$getTxsForBlock('block');
    expect(client.getRawTransaction).toHaveBeenCalledTimes(1);
    expect(client.getRawTransaction).toHaveBeenCalledWith('other-parent', true);
    expect(txs[1].fee).toBe(100010000);
  });

  test('uses verbosity 2 when a node explicitly rejects verbosity 3', async () => {
    const client = clientFor();
    client.getBlock.mockRejectedValueOnce(Object.assign(new Error('Invalid verbosity'), { code: -8 }));
    await new BitcoinApi(client).$getTxsForBlock('block');
    expect(client.getBlock.mock.calls).toEqual([['block', 3], ['block', 2]]);
  });

  test.each([
    { code: 'EHTTP', message: 'HTTP 503' },
    { code: -5, message: 'Block not found' },
    { code: -8, message: 'Invalid block hash' },
  ])('propagates $message without retrying', async error => {
    const client = clientFor();
    client.getBlock.mockRejectedValue(error);
    await expect(new BitcoinApi(client).$getTxsForBlock('block')).rejects.toBe(error);
    expect(client.getBlock).toHaveBeenCalledTimes(1);
  });

  test('keeps the Liquid block request at verbosity 2', async () => {
    jest.spyOn(Common, 'isLiquid').mockReturnValue(true);
    const client = clientFor();
    await new BitcoinApi(client).$getTxsForBlock('block');
    expect(client.getBlock).toHaveBeenCalledWith('block', 2);
  });

  test('retains orphan status and tolerates unavailable prevouts as before', async () => {
    const block = fixture();
    block.confirmations = -1;
    delete block.tx[1].vin[0].prevout;
    const client = clientFor(block);
    client.getRawTransaction.mockRejectedValue(new Error('No such transaction'));
    const txs = await new BitcoinApi(client).$getTxsForBlock('block');
    expect(txs[1].vin[0].prevout).toBeNull();
    expect(txs[1].status.block_hash).toBe('block');
  });
});
