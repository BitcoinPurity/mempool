import crypto from 'crypto-js';
import BitcoindElectrsApi from '../../api/bitcoin/electrum-api';
import memoryCache from '../../api/memory-cache';

jest.mock('@mempool/electrum-client', () => {
  return jest.fn().mockImplementation(() => ({
    initElectrum: jest.fn().mockResolvedValue(undefined),
    close: jest.fn(),
    reconnect: jest.fn(),
    blockchainScripthash_getBalance: jest.fn(),
    blockchainScripthash_getHistory: jest.fn(),
  }));
});

jest.mock('../../api/bitcoin/bitcoin-api', () => {
  return {
    __esModule: true,
    default: class BitcoinApi {
      protected bitcoindClient: any;
      constructor(bitcoinClient: any) {
        this.bitcoindClient = bitcoinClient;
      }
    },
  };
});

const ENCODED_SCRIPT_HASH = 'aa'.repeat(32);
const SCRIPT_PUB_KEY = '0014' + '11'.repeat(20);
const HISTORY = [{ height: 100, tx_hash: 'ab'.repeat(32) }];
const BALANCE = { confirmed: 123, unconfirmed: 0 };

function encodeScriptHash(scriptPubKey: string): string {
  const addrScripthash = crypto.enc.Hex.stringify(crypto.SHA256(crypto.enc.Hex.parse(scriptPubKey)));
  return addrScripthash!.match(/.{2}/g)!.reverse().join('');
}

function createApi(electrumClient: any): BitcoindElectrsApi {
  return new BitcoindElectrsApi({}, electrumClient);
}

describe('BitcoindElectrsApi script hash RPC', () => {
  let electrumClient: {
    blockchainScripthash_getBalance: jest.Mock;
    blockchainScripthash_getHistory: jest.Mock;
    close: jest.Mock;
  };
  let api: BitcoindElectrsApi;
  const cacheStore = new Map<string, any>();

  beforeEach(() => {
    cacheStore.clear();
    (memoryCache as any).get = jest.fn((type: string, id: string) => {
      const key = `${type}:${id}`;
      return cacheStore.has(key) ? cacheStore.get(key) : null;
    });
    (memoryCache as any).set = jest.fn((type: string, id: string, data: any) => {
      cacheStore.set(`${type}:${id}`, data);
    });

    electrumClient = {
      blockchainScripthash_getBalance: jest.fn().mockResolvedValue(BALANCE),
      blockchainScripthash_getHistory: jest.fn().mockResolvedValue(HISTORY),
      close: jest.fn(),
    };
    api = createApi(electrumClient);
  });

  test('coalesces 10 concurrent history requests for the same scripthash into 1 Electrum call', async () => {
    let resolveHistory: (value: typeof HISTORY) => void = () => undefined;
    electrumClient.blockchainScripthash_getHistory.mockImplementation(
      () => new Promise((resolve) => { resolveHistory = resolve; })
    );

    const requests = Array.from({ length: 10 }, () => (api as any).$getEncodedScriptHashHistory(ENCODED_SCRIPT_HASH));
    await Promise.resolve();

    expect(electrumClient.blockchainScripthash_getHistory).toHaveBeenCalledTimes(1);
    expect(electrumClient.blockchainScripthash_getHistory).toHaveBeenCalledWith(ENCODED_SCRIPT_HASH);
    expect((api as any).historyRequests.size).toBe(1);

    resolveHistory(HISTORY);
    const results = await Promise.all(requests);

    expect(results).toHaveLength(10);
    results.forEach((result) => expect(result).toEqual(HISTORY));
    expect((api as any).historyRequests.size).toBe(0);
  });

  test('clears historyRequests after the Electrum call rejects', async () => {
    electrumClient.blockchainScripthash_getHistory.mockRejectedValue(new Error('electrs down'));

    await expect((api as any).$getEncodedScriptHashHistory(ENCODED_SCRIPT_HASH)).rejects.toThrow('electrs down');
    expect((api as any).historyRequests.size).toBe(0);
  });

  test('coalesces 10 concurrent balance requests for the same scripthash into 1 Electrum call', async () => {
    let resolveBalance: (value: typeof BALANCE) => void = () => undefined;
    electrumClient.blockchainScripthash_getBalance.mockImplementation(
      () => new Promise((resolve) => { resolveBalance = resolve; })
    );

    const requests = Array.from({ length: 10 }, () => (api as any).$getEncodedScriptHashBalance(ENCODED_SCRIPT_HASH));
    await Promise.resolve();

    expect(electrumClient.blockchainScripthash_getBalance).toHaveBeenCalledTimes(1);
    expect(electrumClient.blockchainScripthash_getBalance).toHaveBeenCalledWith(ENCODED_SCRIPT_HASH);
    expect((api as any).balanceRequests.size).toBe(1);

    resolveBalance(BALANCE);
    const results = await Promise.all(requests);

    expect(results).toHaveLength(10);
    results.forEach((result) => expect(result).toEqual(BALANCE));
    expect((api as any).balanceRequests.size).toBe(0);
  });

  test('clears balanceRequests after the Electrum call rejects', async () => {
    electrumClient.blockchainScripthash_getBalance.mockRejectedValue(new Error('electrs down'));

    await expect((api as any).$getEncodedScriptHashBalance(ENCODED_SCRIPT_HASH)).rejects.toThrow('electrs down');
    expect((api as any).balanceRequests.size).toBe(0);
  });

  test('does not double-encode an Electrum scripthash', async () => {
    await api.$getScriptHash(ENCODED_SCRIPT_HASH);

    expect(electrumClient.blockchainScripthash_getBalance).toHaveBeenCalledWith(ENCODED_SCRIPT_HASH);
    expect(electrumClient.blockchainScripthash_getHistory).toHaveBeenCalledWith(ENCODED_SCRIPT_HASH);

    const doubleEncoded = encodeScriptHash(ENCODED_SCRIPT_HASH);
    expect(doubleEncoded).not.toBe(ENCODED_SCRIPT_HASH);
    expect(electrumClient.blockchainScripthash_getBalance).not.toHaveBeenCalledWith(doubleEncoded);
    expect(electrumClient.blockchainScripthash_getHistory).not.toHaveBeenCalledWith(doubleEncoded);
  });

  test('encodes a raw scriptPubKey before calling Electrum', async () => {
    const encoded = encodeScriptHash(SCRIPT_PUB_KEY);

    await (api as any).$getScriptHashHistory(SCRIPT_PUB_KEY);
    await (api as any).$getScriptHashBalance(SCRIPT_PUB_KEY);

    expect(electrumClient.blockchainScripthash_getHistory).toHaveBeenCalledWith(encoded);
    expect(electrumClient.blockchainScripthash_getBalance).toHaveBeenCalledWith(encoded);
    expect(electrumClient.blockchainScripthash_getHistory).not.toHaveBeenCalledWith(SCRIPT_PUB_KEY);
    expect(electrumClient.blockchainScripthash_getBalance).not.toHaveBeenCalledWith(SCRIPT_PUB_KEY);
  });

  test('does not call Electrum for history on cache hit', async () => {
    cacheStore.set(`Scripthash_getHistory:${ENCODED_SCRIPT_HASH}`, HISTORY);

    const history = await (api as any).$getEncodedScriptHashHistory(ENCODED_SCRIPT_HASH);

    expect(history).toEqual(HISTORY);
    expect(electrumClient.blockchainScripthash_getHistory).not.toHaveBeenCalled();
    expect((api as any).historyRequests.size).toBe(0);
  });
});
