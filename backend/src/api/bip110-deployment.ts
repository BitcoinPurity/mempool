import config from '../config';
import blocks from './blocks';

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
    // Other networks have no verified fixed Purity activation parameters.
    if (config.MEMPOOL.NETWORK !== 'mainnet' || currentHeight < 0) {
      return null;
    }
    return {
      state: currentHeight >= MAINNET_REDUCED_DATA_ACTIVATION_HEIGHT ? 'active' : 'not_active',
      permanent: true,
      currentHeight,
      activationHeight: MAINNET_REDUCED_DATA_ACTIVATION_HEIGHT,
      expiryHeight: null,
    };
  }
}

export default new PurityReducedDataApi();
