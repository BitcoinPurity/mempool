import config from '../../config';
import { DB } from '../../database';
import logger from '../../logger';

/** Connection pool for the dedicated supply database on the existing MariaDB server. */
export const supplyDb = new DB({ database: config.SUPPLY_DISTRIBUTION.DATABASE });

export const SUPPLY_SCHEMA_VERSION = 1;

/** Table definition shared by the live table and the bootstrap staging table. */
export function balancesTableSql(table: string, withBalanceIndex: boolean): string {
  return `CREATE TABLE IF NOT EXISTS \`${table}\` (
    script_hash BINARY(32) NOT NULL,
    script VARBINARY(10000) NOT NULL,
    balance BIGINT UNSIGNED NOT NULL,
    utxo_count INT UNSIGNED NOT NULL,
    PRIMARY KEY (script_hash)${withBalanceIndex ? ',\n    KEY balance (balance, script_hash)' : ''}
  ) ENGINE=InnoDB ROW_FORMAT=DYNAMIC`;
}

const SCHEMA_V1 = [
  `CREATE TABLE IF NOT EXISTS supply_schema_version (
    id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
    version INT UNSIGNED NOT NULL
  ) ENGINE=InnoDB`,
  balancesTableSql('supply_balances', true),
  `CREATE TABLE IF NOT EXISTS supply_buckets (
    bucket TINYINT UNSIGNED NOT NULL PRIMARY KEY,
    min_sats BIGINT UNSIGNED NOT NULL,
    max_sats BIGINT UNSIGNED NULL,
    script_count BIGINT UNSIGNED NOT NULL,
    amount BIGINT UNSIGNED NOT NULL
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS supply_state (
    id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
    height INT UNSIGNED NOT NULL,
    hash CHAR(64) NOT NULL,
    total_amount BIGINT UNSIGNED NOT NULL,
    utxo_count BIGINT UNSIGNED NOT NULL,
    script_count BIGINT UNSIGNED NOT NULL,
    zero_balance_scripts BIGINT UNSIGNED NOT NULL,
    bootstrap_height INT UNSIGNED NOT NULL,
    status ENUM('bootstrapping', 'ready', 'stale') NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`,
];

/** Create or upgrade the supply schema. Safe to run repeatedly. */
/** @asyncUnsafe */
export async function $initializeSupplySchema(db: DB = supplyDb): Promise<void> {
  for (const sql of SCHEMA_V1) {
    await db.query(sql);
  }
  const [rows] = await db.query<any[]>('SELECT version FROM supply_schema_version WHERE id = 1');
  const current = rows.length ? Number(rows[0].version) : 0;
  if (current > SUPPLY_SCHEMA_VERSION) {
    throw new Error(`Supply database schema version ${current} is newer than this backend (${SUPPLY_SCHEMA_VERSION})`);
  }
  if (current < SUPPLY_SCHEMA_VERSION) {
    await db.query('INSERT INTO supply_schema_version (id, version) VALUES (1, ?) ON DUPLICATE KEY UPDATE version = VALUES(version)',
      [SUPPLY_SCHEMA_VERSION]);
    logger.info(`Supply database schema initialized at version ${SUPPLY_SCHEMA_VERSION}`);
  }
}
