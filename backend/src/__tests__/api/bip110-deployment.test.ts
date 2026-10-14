import config from '../../config';
import blocks from '../../api/blocks';
import bitcoinApi from '../../api/bitcoin/bitcoin-api-factory';
import electrumApi from '../../api/bitcoin/electrum-api';
import database from '../../database';
import reducedData from '../../api/bip110-deployment';

jest.mock('../../api/blocks', () => ({ getCurrentBlockHeight: jest.fn(), $getBlock: jest.fn() }));
jest.mock('../../api/bitcoin/bitcoin-api-factory', () => ({ $getBlockHash: jest.fn() }));
jest.mock('../../api/bitcoin/electrum-api', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../database', () => ({ query: jest.fn() }));

describe('Purity permanent reduced-data status', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    config.MEMPOOL.NETWORK = 'mainnet';
    (blocks.getCurrentBlockHeight as jest.Mock).mockReturnValue(968113);
  });

  test.each([961636, 961637, 961638, 1018080, 2000000])('reports permanent activation correctly at height %i', height => {
    (blocks.getCurrentBlockHeight as jest.Mock).mockReturnValue(height);
    expect(reducedData.getStatus()).toEqual({
      state: height >= 961637 ? 'active' : 'not_active',
      permanent: true,
      currentHeight: height,
      activationHeight: 961637,
      expiryHeight: null,
    });
  });

  test('reads the in-memory tip synchronously without Core, Electrum or database access', () => {
    const status = reducedData.getStatus();
    expect(status).not.toBeInstanceOf(Promise);
    expect(status?.state).toBe('active');
    expect(bitcoinApi.$getBlockHash).not.toHaveBeenCalled();
    expect(blocks.$getBlock).not.toHaveBeenCalled();
    expect(electrumApi).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
  });

  test('uses the announced block height even if the cached tip is behind', () => {
    (blocks.getCurrentBlockHeight as jest.Mock).mockReturnValue(961636);
    expect(reducedData.getStatus(961637)?.state).toBe('active');
  });

  test('follows a reorg below activation without retaining a lock-in cache', () => {
    expect(reducedData.getStatus(961637)?.state).toBe('active');
    expect(reducedData.getStatus(961636)?.state).toBe('not_active');
  });

  test('does not derive reduced-data activation from ASERT configuration', () => {
    const activation = config.PURITY.ACTIVATION_HEIGHT;
    const anchor = config.PURITY.ASERT_ANCHOR_HEIGHT;
    try {
      config.PURITY.ACTIVATION_HEIGHT = 1;
      config.PURITY.ASERT_ANCHOR_HEIGHT = 0;
      expect(reducedData.getStatus(961636)?.state).toBe('not_active');
      expect(reducedData.getStatus(961637)?.activationHeight).toBe(961637);
    } finally {
      config.PURITY.ACTIVATION_HEIGHT = activation;
      config.PURITY.ASERT_ANCHOR_HEIGHT = anchor;
    }
  });

  test('omits status before the tip is known', () => {
    (blocks.getCurrentBlockHeight as jest.Mock).mockReturnValue(-1);
    expect(reducedData.getStatus()).toBeNull();
  });

  test.each(['testnet', 'testnet4', 'signet', 'regtest', 'liquid', 'liquidtestnet'] as const)(
    'does not invent permanent activation parameters for %s', network => {
      config.MEMPOOL.NETWORK = network;
      expect(reducedData.getStatus()).toBeNull();
    }
  );
});
