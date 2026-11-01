import { OFFICIAL_SIGNET } from '../purity-config';
import logger from '../logger';

export type SignetIdentity = 'pending' | 'verified';

interface SignetRpc {
  getBlockchainInfo(): Promise<{ chain: string; blocks: number }>;
  getBlockHash(height: number): Promise<string>;
}

export class PuritySignetValidator {
  public ready = false;
  private status: SignetIdentity | null = null;

  constructor(private rpc: SignetRpc, private validateIndexer: () => Promise<SignetIdentity>) {}

  public async validate(): Promise<SignetIdentity> {
    try {
      const info = await this.rpc.getBlockchainInfo();
      if (info.chain !== 'signet') {
        throw new Error('Purity Signet requires RPC chain=signet');
      }
      const coreReady = info.blocks >= OFFICIAL_SIGNET.ACTIVATION_HEIGHT;
      if (coreReady && await this.rpc.getBlockHash(OFFICIAL_SIGNET.ACTIVATION_HEIGHT) !== OFFICIAL_SIGNET.ACTIVATION_HASH) {
        throw new Error('RPC Purity Signet activation hash mismatch');
      }
      const indexerStatus = await this.validateIndexer();
      const status = coreReady && indexerStatus === 'verified' ? 'verified' : 'pending';
      if (status !== this.status) {
        if (status === 'pending') {
          logger.warn('Purity Signet identity pending: RPC or indexer is below activation; shared historical data only');
        } else {
          logger.info('Purity Signet activation hash verified on RPC and indexer');
        }
      }
      this.status = status;
      this.ready = true;
      return status;
    } catch (error) {
      this.ready = false;
      this.status = null;
      throw error;
    }
  }
}
