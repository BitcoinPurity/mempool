import config from '../config';
import blocks from './blocks';
import { OFFICIAL_SIGNET } from '../purity-config';

// Purity consensus: doc/purity-consensus.md, Consensus::MAINNET_PURITY_ACTIVATION_HEIGHT.
// This is independent of the explorer's ASERT activation/anchor configuration.
const MAINNET_REDUCED_DATA_ACTIVATION_HEIGHT = 961637;

export interface PurityReducedDataStatus {
  state: 'active' | 'not_active';
  permanent: true;
  currentHeight: number;
  activationHeight: number | null;
  expiryHeight: null;
}

class PurityReducedDataApi {
  public getStatus(currentHeight = blocks.getCurrentBlockHeight()): PurityReducedDataStatus | null {
    if (!['mainnet', 'signet'].includes(config.MEMPOOL.NETWORK) || currentHeight < 0) {
      return null;
    }
    const activationHeight = config.MEMPOOL.NETWORK === 'signet'
      ? OFFICIAL_SIGNET.ACTIVATION_HEIGHT : MAINNET_REDUCED_DATA_ACTIVATION_HEIGHT;
    return {
      state: currentHeight >= activationHeight ? 'active' : 'not_active',
      permanent: true,
      currentHeight,
      activationHeight,
      expiryHeight: null,
    };
  }
}

export default new PurityReducedDataApi();
