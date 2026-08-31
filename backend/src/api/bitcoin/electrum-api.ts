import config from '../../config';
import Client from '@mempool/electrum-client';
import { AbstractBitcoinApi } from './bitcoin-api-abstract-factory';
import { IEsploraApi } from './esplora-api.interface';
import { IElectrumApi } from './electrum-api.interface';
import BitcoinApi from './bitcoin-api';
import logger from '../../logger';
import crypto from 'crypto-js';
import loadingIndicators from '../loading-indicators';
import memoryCache from '../memory-cache';

const ELECTRUM_RETRY_PERIOD_MS = 5000;
const ELECTRUM_HISTORY_CACHE_SECONDS = 10;
const ELECTRUM_BALANCE_TIMEOUT_MS = 15_000;
const ELECTRUM_HISTORY_TIMEOUT_MS = 30_000;

class BitcoindElectrsApi extends BitcoinApi implements AbstractBitcoinApi {
  private electrumClient: any;
  private historyRequests = new Map<string, Promise<IElectrumApi.ScriptHashHistory[]>>();
  private balanceRequests = new Map<string, Promise<IElectrumApi.ScriptHashBalance>>();

  constructor(bitcoinClient: any, electrumClient?: any) {
    super(bitcoinClient);

    if (electrumClient) {
      this.electrumClient = electrumClient;
      return;
    }

    const electrumConfig = { client: 'mempool-v2', version: '1.4' };
    const electrumPersistencePolicy = { retryPeriod: ELECTRUM_RETRY_PERIOD_MS, maxRetry: Number.MAX_SAFE_INTEGER, callback: null };

    const electrumCallbacks = {
      onConnect: (client, versionInfo) => { logger.debug(`Electrum connect at ${config.ELECTRUM.HOST}:${config.ELECTRUM.PORT} (${JSON.stringify(versionInfo)})`); },
      onClose: (client) => { logger.debug(`Electrum close at ${config.ELECTRUM.HOST}:${config.ELECTRUM.PORT}`); },
      onError: (err) => { logger.err(`Electrum error: ${JSON.stringify(err)}`); },
      onLog: (str) => { logger.debug(str); },
    };

    this.electrumClient = new Client(
      config.ELECTRUM.PORT,
      config.ELECTRUM.HOST,
      config.ELECTRUM.TLS_ENABLED ? 'tls' : 'tcp',
      null,
      electrumCallbacks
    );

    this.patchElectrumClientSocketLifecycle();

    this.electrumClient.initElectrum(electrumConfig, electrumPersistencePolicy)
      .then(() => { })
      .catch((err) => {
        logger.err(`Error connecting to Electrum Server at ${config.ELECTRUM.HOST}:${config.ELECTRUM.PORT}: ${err && err.message ? err.message : err}`);
      });
  }

  /**
   * @mempool/electrum-client 1.1.9 reconnect() calls initSocket() without
   * destroying the previous TCP socket. Abandoned sockets stay in CLOSE-WAIT
   * on electrs when a FIN is sent while a slow RPC is still running.
   */
  private patchElectrumClientSocketLifecycle(): void {
    const client = this.electrumClient;
    if (!client || typeof client.reconnect !== 'function') {
      return;
    }

    const originalReconnect = client.reconnect.bind(client);
    let reconnectInFlight = false;

    client.reconnect = () => {
      if (reconnectInFlight) {
        logger.debug('Electrum reconnect skipped: already in progress');
        return Promise.resolve(client);
      }
      reconnectInFlight = true;
      logger.debug(`Electrum reconnecting to ${config.ELECTRUM.HOST}:${config.ELECTRUM.PORT}`);

      const oldConn = client.conn;
      if (oldConn) {
        try {
          oldConn.removeAllListeners();
          oldConn.destroy();
        } catch (e: any) {
          logger.debug(`Electrum old socket destroy failed: ${e && e.message ? e.message : e}`);
        }
      }

      return Promise.resolve()
        .then(() => originalReconnect())
        .finally(() => {
          reconnectInFlight = false;
        });
    };
  }

  public close(): void {
    logger.debug(`Electrum client shutdown at ${config.ELECTRUM.HOST}:${config.ELECTRUM.PORT}`);
    this.historyRequests.clear();
    this.balanceRequests.clear();
    if (this.electrumClient && typeof this.electrumClient.close === 'function') {
      this.electrumClient.close();
    }
  }

  /** @asyncUnsafe */
  async $getAddress(address: string): Promise<IEsploraApi.Address> {
    const addressInfo = await this.bitcoindClient.validateAddress(address);
    if (!addressInfo || !addressInfo.isvalid) {
      throw new Error('Invalid Bitcoin address');
    }

    try {
      const balance = await this.$getScriptHashBalance(addressInfo.scriptPubKey);
      const history = await this.$getScriptHashHistory(addressInfo.scriptPubKey);

      const unconfirmed = history.filter((h) => h.fee).length;

      return {
        'address': addressInfo.address,
        'chain_stats': {
          'funded_txo_count': 0,
          'funded_txo_sum': balance.confirmed ? balance.confirmed : 0,
          'spent_txo_count': 0,
          'spent_txo_sum': balance.confirmed < 0 ? balance.confirmed : 0,
          'tx_count': history.length - unconfirmed,
        },
        'mempool_stats': {
          'funded_txo_count': 0,
          'funded_txo_sum': balance.unconfirmed > 0 ? balance.unconfirmed : 0,
          'spent_txo_count': 0,
          'spent_txo_sum': balance.unconfirmed < 0 ? -balance.unconfirmed : 0,
          'tx_count': unconfirmed,
        },
        'electrum': true,
      };
    } catch (e: any) {
      throw new Error(typeof e === 'string' ? e : e && e.message || e);
    }
  }

  /** @asyncUnsafe */
  async $getAddressTransactions(address: string, lastSeenTxId: string): Promise<IEsploraApi.Transaction[]> {
    const addressInfo = await this.bitcoindClient.validateAddress(address);
    if (!addressInfo || !addressInfo.isvalid) {
      throw new Error('Invalid Bitcoin address');
    }

    try {
      loadingIndicators.setProgress('address-' + address, 0);

      const transactions: IEsploraApi.Transaction[] = [];
      const history = await this.$getScriptHashHistory(addressInfo.scriptPubKey);
      history.sort((a, b) => (b.height || 9999999) - (a.height || 9999999));

      let startingIndex = 0;
      if (lastSeenTxId) {
        const pos = history.findIndex((historicalTx) => historicalTx.tx_hash === lastSeenTxId);
        if (pos) {
          startingIndex = pos + 1;
        }
      }
      const endIndex = Math.min(startingIndex + 10, history.length);

      for (let i = startingIndex; i < endIndex; i++) {
        const tx = await this.$getRawTransaction(history[i].tx_hash, false, true);
        transactions.push(tx);
        loadingIndicators.setProgress('address-' + address, (i + 1) / endIndex * 100);
      }

      return transactions;
    } catch (e: any) {
      loadingIndicators.setProgress('address-' + address, 100);
      throw new Error(typeof e === 'string' ? e : e && e.message || e);
    }
  }

  async $getScriptHash(scripthash: string): Promise<IEsploraApi.ScriptHash> {
    try {
      const balance = await this.$getEncodedScriptHashBalance(scripthash);
      const history = await this.$getEncodedScriptHashHistory(scripthash);

      const unconfirmed = history ? history.filter((h) => h.fee).length : 0;

      return {
        'scripthash': scripthash,
        'chain_stats': {
          'funded_txo_count': 0,
          'funded_txo_sum': balance.confirmed ? balance.confirmed : 0,
          'spent_txo_count': 0,
          'spent_txo_sum': balance.confirmed < 0 ? balance.confirmed : 0,
          'tx_count': (history?.length || 0) - unconfirmed,
        },
        'mempool_stats': {
          'funded_txo_count': 0,
          'funded_txo_sum': balance.unconfirmed > 0 ? balance.unconfirmed : 0,
          'spent_txo_count': 0,
          'spent_txo_sum': balance.unconfirmed < 0 ? -balance.unconfirmed : 0,
          'tx_count': unconfirmed,
        },
        'electrum': true,
      };
    } catch (e: any) {
      throw new Error(typeof e === 'string' ? e : e && e.message || e);
    }
  }

  /** @asyncUnsafe */
  async $getAddressUtxos(address: string): Promise<IEsploraApi.UTXO[]> {
    const addressInfo = await this.bitcoindClient.validateAddress(address);
    if (!addressInfo || !addressInfo.isvalid) {
      throw new Error('Invalid Bitcoin address');
    }
    const scripthash = this.encodeScriptHash(addressInfo.scriptPubKey);
    return this.$getScriptHashUtxos(scripthash);
  }

  async $getScriptHashTransactions(scripthash: string, lastSeenTxId?: string): Promise<IEsploraApi.Transaction[]> {
    try {
      loadingIndicators.setProgress('address-' + scripthash, 0);

      const transactions: IEsploraApi.Transaction[] = [];
      const history = await this.$getEncodedScriptHashHistory(scripthash);
      if (!history) {
        throw new Error('failed to get scripthash history');
      }
      history.sort((a, b) => (b.height || 9999999) - (a.height || 9999999));

      let startingIndex = 0;
      if (lastSeenTxId) {
        const pos = history.findIndex((historicalTx) => historicalTx.tx_hash === lastSeenTxId);
        if (pos) {
          startingIndex = pos + 1;
        }
      }
      const endIndex = Math.min(startingIndex + 10, history.length);

      for (let i = startingIndex; i < endIndex; i++) {
        const tx = await this.$getRawTransaction(history[i].tx_hash, false, true);
        transactions.push(tx);
        loadingIndicators.setProgress('address-' + scripthash, (i + 1) / endIndex * 100);
      }

      return transactions;
    } catch (e: any) {
      loadingIndicators.setProgress('address-' + scripthash, 100);
      throw new Error(typeof e === 'string' ? e : e && e.message || e);
    }
  }

  /** @asyncUnsafe */
  async $getScriptHashUtxos(scripthash: string): Promise<IEsploraApi.UTXO[]> {
    const utxos = await this.$getScriptHashUnspent(scripthash);
    const result: IEsploraApi.UTXO[] = [];
    for(const utxo of utxos) {
      if(utxo.height===0) {
        //Unconfirmed
        result.push({
          txid: utxo.tx_hash,
          vout: utxo.tx_pos,
          status: {
            confirmed: false
          },
          value: utxo.value
        });
      } else {
        //Confirmed
        const blockHash = await this.$getBlockHash(utxo.height);
        const block = await this.$getBlock(blockHash);
        result.push({
          txid: utxo.tx_hash,
          vout: utxo.tx_pos,
          status: {
            confirmed: true,
            block_height: utxo.height,
            block_hash: blockHash,
            block_time: block.timestamp
          },
          value: utxo.value
        });
      }
    }
    return result;
  }

  private $getScriptHashUnspent(scriptHash: string): Promise<IElectrumApi.ScriptHashUtxos[]> {
    return this.electrumClient.blockchainScripthash_listunspent(scriptHash);
  }

  /** @asyncUnsafe */
  async $getTransactionMerkleProof(txId: string): Promise<IEsploraApi.MerkleProof> {
    const tx = await this.$getRawTransaction(txId);
    return this.electrumClient.blockchainTransaction_getMerkle(txId, tx.status.block_height);
  }

  private $getScriptHashBalance(scriptPubKey: string): Promise<IElectrumApi.ScriptHashBalance> {
    return this.$getEncodedScriptHashBalance(this.encodeScriptHash(scriptPubKey));
  }

  private $getScriptHashHistory(scriptPubKey: string): Promise<IElectrumApi.ScriptHashHistory[]> {
    return this.$getEncodedScriptHashHistory(this.encodeScriptHash(scriptPubKey));
  }

  private $getEncodedScriptHashBalance(encodedScriptHash: string): Promise<IElectrumApi.ScriptHashBalance> {
    const inFlight = this.balanceRequests.get(encodedScriptHash);
    if (inFlight) {
      logger.debug(`Electrum get_balance coalesced: scripthash=${encodedScriptHash} inFlight=${this.balanceRequests.size}`);
      return inFlight;
    }

    const rpc: Promise<IElectrumApi.ScriptHashBalance> = this.electrumClient.blockchainScripthash_getBalance(encodedScriptHash);
    rpc.catch(() => { /* timeout/close may reject after the HTTP caller already left */ });

    const request = this.$rpcWithTimeout('get_balance', encodedScriptHash, ELECTRUM_BALANCE_TIMEOUT_MS, rpc)
      .finally(() => {
        this.balanceRequests.delete(encodedScriptHash);
      });

    this.balanceRequests.set(encodedScriptHash, request);
    logger.debug(`Electrum get_balance start: scripthash=${encodedScriptHash} inFlight=${this.balanceRequests.size}`);
    return request;
  }

  private $getEncodedScriptHashHistory(encodedScriptHash: string): Promise<IElectrumApi.ScriptHashHistory[]> {
    const fromCache = memoryCache.get<IElectrumApi.ScriptHashHistory[]>('Scripthash_getHistory', encodedScriptHash);
    if (fromCache) {
      return Promise.resolve(fromCache);
    }

    const inFlight = this.historyRequests.get(encodedScriptHash);
    if (inFlight) {
      logger.debug(`Electrum get_history coalesced: scripthash=${encodedScriptHash} inFlight=${this.historyRequests.size}`);
      return inFlight;
    }

    const rpc: Promise<IElectrumApi.ScriptHashHistory[]> = this.electrumClient.blockchainScripthash_getHistory(encodedScriptHash)
      .then((history) => {
        memoryCache.set('Scripthash_getHistory', encodedScriptHash, history, ELECTRUM_HISTORY_CACHE_SECONDS);
        return history;
      });
    rpc.catch(() => { /* timeout/close may reject after the HTTP caller already left */ });

    const request = this.$rpcWithTimeout('get_history', encodedScriptHash, ELECTRUM_HISTORY_TIMEOUT_MS, rpc)
      .finally(() => {
        this.historyRequests.delete(encodedScriptHash);
      });

    this.historyRequests.set(encodedScriptHash, request);
    logger.debug(`Electrum get_history start: scripthash=${encodedScriptHash} inFlight=${this.historyRequests.size}`);
    return request;
  }

  private $rpcWithTimeout<T>(method: string, scripthash: string, timeoutMs: number, rpc: Promise<T>): Promise<T> {
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        logger.debug(`Electrum RPC timeout: method=${method} scripthash=${scripthash} elapsed=${Date.now() - started}ms inFlight=${this.historyRequests.size + this.balanceRequests.size}`);
        reject(new Error(`Electrum RPC timeout: ${method}`));
      }, timeoutMs);
    });

    return Promise.race([rpc, timeoutPromise]).finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    });
  }

  private encodeScriptHash(scriptPubKey: string): string {
    const addrScripthash = crypto.enc.Hex.stringify(crypto.SHA256(crypto.enc.Hex.parse(scriptPubKey)));
    return addrScripthash!.match(/.{2}/g)!.reverse().join('');
  }

}

export default BitcoindElectrsApi;
