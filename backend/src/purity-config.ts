import {
  ASERT_HALF_LIFE, DEFAULT_PURITY_ACTIVATION_HEIGHT, MAINNET_ASERT_ANCHOR_HEIGHT,
  MAINNET_POW_LIMIT, POW_TARGET_SPACING, bitsToTarget,
} from './api/asert';

export interface PurityConfig {
  ACTIVATION_HEIGHT: number;
  ASERT_ANCHOR_HEIGHT: number;
  POW_LIMIT: string;
  ASERT_HALF_LIFE: number;
  POW_TARGET_SPACING: number;
  ASERT_ANCHOR_BITS?: number;
  ASERT_ANCHOR_PARENT_TIME?: number;
  ACTIVATION_HASH?: string;
}

export const OFFICIAL_SIGNET = Object.freeze({
  ACTIVATION_HEIGHT: 327022,
  ASERT_ANCHOR_HEIGHT: 327017,
  ASERT_ANCHOR_BITS: 0x1d154f9b,
  ASERT_ANCHOR_PARENT_TIME: 1792401042,
  ASERT_HALF_LIFE,
  POW_TARGET_SPACING,
  POW_LIMIT: '00000377ae000000000000000000000000000000000000000000000000000000',
  ACTIVATION_HASH: '00000004b42cf68f94be9dd89b65e44cae31eee382137221b83b5b261d3e3c20',
} satisfies PurityConfig);

export function resolvePurityConfig(network: string, overrides: Partial<PurityConfig> = {}): PurityConfig {
  const profile: PurityConfig = network === 'signet' ? OFFICIAL_SIGNET : {
    ACTIVATION_HEIGHT: DEFAULT_PURITY_ACTIVATION_HEIGHT,
    ASERT_ANCHOR_HEIGHT: MAINNET_ASERT_ANCHOR_HEIGHT,
    POW_LIMIT: MAINNET_POW_LIMIT.toString(16).padStart(64, '0'),
    ASERT_HALF_LIFE,
    POW_TARGET_SPACING,
  };
  const params = { ...profile, ...overrides };
  for (const key of ['ACTIVATION_HEIGHT', 'ASERT_ANCHOR_HEIGHT', 'ASERT_HALF_LIFE', 'POW_TARGET_SPACING'] as const) {
    if (!Number.isSafeInteger(params[key]) || params[key] < 1) {
      throw new Error(`Invalid PURITY.${key}`);
    }
  }
  if (params.ACTIVATION_HEIGHT <= params.ASERT_ANCHOR_HEIGHT || params.ACTIVATION_HEIGHT >= 0x7fffffff) {
    throw new Error('PURITY activation must follow its anchor and be below INT_MAX');
  }
  if (!/^[0-9a-f]{64}$/i.test(params.POW_LIMIT) || BigInt('0x' + params.POW_LIMIT) <= 0n ||
      BigInt('0x' + params.POW_LIMIT) >> BigInt(network === 'signet' ? 239 : 224)) {
    throw new Error('Invalid PURITY.POW_LIMIT');
  }
  if ((params.ASERT_ANCHOR_BITS === undefined) !== (params.ASERT_ANCHOR_PARENT_TIME === undefined)) {
    throw new Error('PURITY anchor bits and parent time must be configured together');
  }
  if (params.ASERT_ANCHOR_BITS !== undefined) {
    let target: bigint;
    try { target = bitsToTarget(params.ASERT_ANCHOR_BITS); } catch { throw new Error('Invalid PURITY.ASERT_ANCHOR_BITS'); }
    if (target <= 0n || target > BigInt('0x' + params.POW_LIMIT) ||
        typeof params.ASERT_ANCHOR_PARENT_TIME !== 'number' ||
        !Number.isSafeInteger(params.ASERT_ANCHOR_PARENT_TIME) || params.ASERT_ANCHOR_PARENT_TIME <= 0) {
      throw new Error('Invalid PURITY anchor target or parent time');
    }
  }
  if (network === 'signet') {
    for (const key of Object.keys(OFFICIAL_SIGNET) as (keyof PurityConfig)[]) {
      if (params[key] !== OFFICIAL_SIGNET[key]) {
        throw new Error(`PURITY.${key} does not match official Purity Signet`);
      }
    }
  }
  for (const key of ['POW_LIMIT', 'ASERT_HALF_LIFE', 'POW_TARGET_SPACING'] as const) {
    if (params[key] !== profile[key]) {
      throw new Error(`PURITY.${key} does not match ${network} consensus`);
    }
  }
  return params;
}
