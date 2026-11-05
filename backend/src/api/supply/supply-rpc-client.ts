import config from '../../config';
const bitcoin = require('../../rpc-api/index');
import { BitcoinRpcCredentials } from '../bitcoin/bitcoin-api-abstract-factory';

/** Same node and credentials as CORE_RPC, with a timeout long enough for `dumptxoutset`. */
const dumpRpcCredentials: BitcoinRpcCredentials = {
  host: config.CORE_RPC.HOST,
  port: config.CORE_RPC.PORT,
  user: config.CORE_RPC.USERNAME,
  pass: config.CORE_RPC.PASSWORD,
  timeout: config.SUPPLY_DISTRIBUTION.DUMP_TIMEOUT,
  cookie: config.CORE_RPC.COOKIE ? config.CORE_RPC.COOKIE_PATH : undefined,
};

export interface DumpTxOutSetResult {
  coins_written: number;
  base_hash: string;
  base_height: number;
  path: string;
  txoutset_hash: string;
  nchaintx: number;
}

export interface SupplyDumpClient {
  dumpTxOutSet(path: string, type: 'latest'): Promise<DumpTxOutSetResult>;
}

export default new bitcoin.Client(dumpRpcCredentials) as SupplyDumpClient;
