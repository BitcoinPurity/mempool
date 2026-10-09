import { EventEmitter } from 'events';
import config from '../../config';
import blocks from '../../api/blocks';
import bitcoinApi from '../../api/bitcoin/bitcoin-api-factory';
import websocketHandler from '../../api/websocket-handler';

jest.mock('../../api/blocks', () => ({
  getCurrentBlockHeight: jest.fn(() => 961636), getBlocks: () => [], $getBlock: jest.fn(),
}));
jest.mock('../../api/bitcoin/bitcoin-api-factory', () => ({ $getBlockHash: jest.fn() }));
jest.mock('../../api/bitcoin/bitcoin-second-client', () => ({}));
jest.mock('../../api/backend-info', () => ({ getBackendInfo: () => ({ version: 'test' }) }));
jest.mock('../../api/mempool', () => ({
  getMempool: () => ({}), getMempoolInfo: () => ({ size: 1 }), getVBytesPerSecond: () => 5,
  getLatestTransactions: () => [], isInSync: () => true,
}));
jest.mock('../../api/mempool-blocks', () => ({
  getMempoolBlocks: () => [{ blockVSize: 100 }], getMempoolBlockDeltas: () => [],
  getMempoolBlocksWithTransactions: () => [],
}));
jest.mock('../../api/difficulty-adjustment', () => ({ getDifficultyAdjustment: () => ({ previousTime: 100, algorithm: 'asert' }) }));
jest.mock('../../api/fee-api', () => ({ getPreciseRecommendedFee: () => ({ fastestFee: 2 }) }));
jest.mock('../../api/loading-indicators', () => ({ getLoadingIndicators: () => ({ 'bip110-scan': 42 }) }));
jest.mock('../../tasks/price-updater', () => ({ getLatestPrices: () => ({ USD: 100000 }) }));
jest.mock('../../api/transaction-utils', () => ({}));
jest.mock('../../api/services/acceleration', () => ({}));
jest.mock('../../api/statistics/statistics', () => ({}));
jest.mock('../../api/services/wallets', () => ({}));
jest.mock('../../api/cpfp', () => ({}));
jest.mock('../../api/services/stratum', () => ({}));

describe('WebSocket permanent reduced-data status', () => {
  let handler: typeof websocketHandler;
  let server: EventEmitter & { clients: Set<any> };
  let client: EventEmitter & { send: jest.Mock; readyState: number; bufferedAmount: number };

  beforeEach(() => {
    jest.clearAllMocks();
    config.MEMPOOL.NETWORK = 'mainnet';
    config.WALLETS.ENABLED = false;
    (blocks.getCurrentBlockHeight as jest.Mock).mockReturnValue(961636);
    handler = new (websocketHandler.constructor as any)();
    client = Object.assign(new EventEmitter(), { send: jest.fn(), readyState: 1, bufferedAmount: 0 });
    server = Object.assign(new EventEmitter(), { clients: new Set([client]) });
    handler.addWebsocketServer(server as any);
    handler.setupConnectionHandling();
    server.emit('connection', client, { headers: {}, socket: {} });
  });

  const messages = (socket: typeof client) => socket.send.mock.calls.map(([data]) => JSON.parse(data));

  test('initial browser data and init-data contain status and existing fields without historical queries', async () => {
    (blocks.getCurrentBlockHeight as jest.Mock).mockReturnValue(968113);
    await (handler as any).updateSocketData();
    const initial = JSON.parse(handler.getSerializedInitData());
    expect(initial).toMatchObject({
      backend: config.MEMPOOL.BACKEND, blocks: [], mempoolInfo: { size: 1 },
      fees: { fastestFee: 2 }, da: { algorithm: 'asert' },
      loadingIndicators: { 'bip110-scan': 42 }, conversions: { USD: 100000 },
      bip110deployment: { state: 'active', permanent: true, currentHeight: 968113, activationHeight: 961637, expiryHeight: null },
    });
    client.emit('message', Buffer.from(JSON.stringify({ action: 'init' })));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(messages(client)).toContainEqual(initial);
    expect(bitcoinApi.$getBlockHash).not.toHaveBeenCalled();
    expect(blocks.$getBlock).not.toHaveBeenCalled();
  });

  test.each([961637, 963647, 1018080])('announces block %i, permanent status, stats and mempool fields without signaling scans', async height => {
    client.emit('message', Buffer.from(JSON.stringify({ action: 'want', data: ['blocks', 'stats', 'mempool-blocks'] })));
    client.send.mockClear();
    const block = { id: 'test-block', height, timestamp: 1700000000, extras: { bip110ViolationCount: 2, bip110ViolationWeight: 800 } };
    await handler.handleNewBlock(block as any, [], [], {});
    expect(messages(client)).toEqual([expect.objectContaining({
      block, mempoolInfo: { size: 1 }, vBytesPerSecond: 5, fees: { fastestFee: 2 },
      da: { algorithm: 'asert', previousTime: 100 }, 'mempool-blocks': [{ blockVSize: 100 }],
      bip110deployment: { state: 'active', permanent: true, currentHeight: height, activationHeight: 961637, expiryHeight: null },
    })]);
    expect(JSON.parse(handler.getSerializedInitData()).bip110deployment.currentHeight).toBe(height);
    expect(JSON.parse(handler.getSerializedInitData()).loadingIndicators['bip110-scan']).toBe(42);
    expect(bitcoinApi.$getBlockHash).not.toHaveBeenCalled();
    expect(blocks.$getBlock).not.toHaveBeenCalled();
  });

  test('preserves confirmation and mempool-delta notifications alongside the permanent status', async () => {
    const txid = 'ab'.repeat(32);
    client['want-blocks'] = true;
    client['track-tx'] = txid;
    client['track-mempool-txids'] = true;
    client['track-mempool'] = true;
    const transaction = { txid, vin: [], vout: [] };
    await handler.handleNewBlock({ id: 'new-block', height: 968114 } as any, [txid], [transaction] as any, {});
    expect(messages(client)).toEqual([expect.objectContaining({
      txConfirmed: txid,
      'mempool-txids': { sequence: 1, added: [], removed: [], mined: [txid], replaced: [] },
      'mempool-transactions': { sequence: 1, added: [], removed: [], mined: [txid], replaced: [] },
      bip110deployment: expect.objectContaining({ currentHeight: 968114, permanent: true }),
    })]);
  });
});
