export type SupplyStatus = 'bootstrapping' | 'ready' | 'stale';

export interface SupplyDataState {
  status: SupplyStatus;
  /** Height the balances are valid at (the chain tip minus `confirmations`). */
  height: number;
  hash: string;
  updatedAt: number;
  confirmations: number;
}

export interface SupplyBucket {
  bucket: number;
  minSats: number;
  maxSats: number | null;
  scriptCount: number;
  amount: number;
}

export interface SupplyDistribution extends SupplyDataState {
  totalAmount: number;
  issuedAmount: number;
  maxSupply: number;
  utxoCount: number;
  scriptCount: number;
  nonZeroScriptCount: number;
  zeroBalanceScripts: number;
  buckets: SupplyBucket[];
}

export interface SupplyTopAddress {
  rank: number;
  /** Address, or the public key hex for P2PK; null for scripts without an address. */
  address: string | null;
  type: string;
  /** Leading script bytes (hex) when there is no address. */
  script?: string;
  scriptTruncated?: boolean;
  balance: number;
  utxoCount: number;
}

export interface SupplyTopAddresses extends SupplyDataState {
  totalAmount: number;
  total: number;
  page: number;
  limit: number;
  rows: SupplyTopAddress[];
}

export interface SupplyAddressRank extends SupplyDataState {
  rank: number;
  topN: number;
  balance: number;
  utxoCount: number;
  share: number;
}
