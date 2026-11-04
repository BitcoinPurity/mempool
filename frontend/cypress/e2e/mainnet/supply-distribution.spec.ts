import { receiveWebSocketMessageFromServer } from '../../support/websocket';

const COIN = 100_000_000;
const bounds = [0, 0.001, 0.01, 0.1, 1, 10, 100, 1000, 10000, 100000].map((btc) => Math.round(btc * COIN));
const buckets = bounds.map((minSats, bucket) => ({
  bucket, minSats, maxSats: bounds[bucket + 1] ?? null, scriptCount: 1000 - bucket * 90, amount: (bucket + 1) * 100 * COIN,
}));
const state = { status: 'ready', height: 900000, hash: '00'.repeat(32), updatedAt: 1700000000, confirmations: 6 };
const distribution = (height = 900000) => ({
  ...state, height, totalAmount: 1_985_000_000_000_000, issuedAmount: 1_990_000_000_000_000, maxSupply: 2_100_000_000_000_000,
  utxoCount: 170_000_000, scriptCount: 55_000_010, nonZeroScriptCount: 55_000_000, zeroBalanceScripts: 10, buckets,
});
const satoshi = '0496b538e853519c726a2c91e61ec11600ae1390813a627c66fb8be7947be63c52da7589379515d4e0a604f8141781e62294721166bf621e73a82cbf2342c858ee';
const topRows = (page: number) => Array.from({ length: 100 }, (_, i) => {
  const rank = (page - 1) * 100 + i + 1;
  if (rank === 1) {
    return { rank, address: satoshi, type: 'p2pk', balance: 5_000_000_000, utxoCount: 1 };
  }
  if (rank === 2) {
    return { rank, address: null, type: 'multisig', script: '5121' + '02'.repeat(30), scriptTruncated: true, balance: 4_000_000_000, utxoCount: 3 };
  }
  return { rank, address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', type: 'v0_p2wpkh', balance: 3_000_000_000 - rank, utxoCount: 2 };
});

function enableSupply(enabled = true): void {
  cy.intercept('GET', '**/resources/config.js', {
    body: `window.__env = window.__env || {}; window.__env.SUPPLY_DISTRIBUTION_ENABLED = ${enabled};`,
    headers: { 'content-type': 'application/javascript' },
  });
}

describe('Supply Distribution page', () => {
  beforeEach(() => {
    cy.on('window:before:load', (win) => {
      win['__env'] = { MINING_DASHBOARD: false, HISTORICAL_PRICE: false, PURITY_NODES_MAP_ENABLED: false, CORE_TIP_HEIGHT_API: '', CORE_TX_API: '' };
    });
    cy.mockMempoolSocket();
    cy.intercept('GET', '**/api/v1/supply/distribution', (req) => req.reply(distribution())).as('distribution');
    cy.intercept('GET', '**/api/v1/supply/top-addresses*', (req) => {
      const page = Number(new URL(req.url).searchParams.get('page'));
      req.reply({ ...state, totalAmount: 1_985_000_000_000_000, total: 10000, page, limit: 100, rows: topRows(page) });
    }).as('top');
  });

  it('shows overview, balance ranges and top addresses from the genesis-wide supply', () => {
    enableSupply();
    cy.visit('/supply');
    cy.wait(['@distribution', '@top']);
    cy.get('#btn-supply').should('be.visible');
    cy.get('[data-cy=supply-height]').should('contain', '900,000');
    cy.get('[data-cy=supply-funded-addresses]').should('contain', '55,000,000');
    cy.get('[data-cy=supply-buckets] tbody tr').should('have.length', 10);
    cy.get('[data-cy=supply-buckets] tbody tr').first().should('contain', '< 0.001');
    cy.get('[data-cy=supply-buckets] tbody tr').last().should('contain', '≥ 100k');
    cy.get('[data-cy=supply-chart] svg').should('exist');
    cy.get('[data-cy=supply-top] tbody tr').should('have.length', 100);
    cy.get('[data-cy=supply-top] tbody tr').eq(0).find('a').should('have.attr', 'href', `/address/${satoshi}`);
    cy.get('[data-cy=supply-top] tbody tr').eq(1).should('contain', 'Script').and('not.have.descendants', 'a');
    cy.get('[data-cy=supply-status-bootstrapping], [data-cy=supply-status-stale]').should('not.exist');
  });

  it('paginates through the query string', () => {
    enableSupply();
    cy.visit('/supply');
    cy.wait(['@distribution', '@top']);
    cy.get('ngb-pagination').contains('a', '2').click();
    cy.wait('@top').its('request.url').should('contain', 'page=2');
    cy.location('search').should('eq', '?page=2');
    cy.get('[data-cy=supply-top] tbody tr').first().should('contain', '101');
  });

  it('refetches after a new block arrives', () => {
    enableSupply();
    cy.visit('/supply');
    cy.wait(['@distribution', '@top']);
    const block = (height: number) => ({ id: height.toString(16).padStart(64, '0'), height, timestamp: 1700000000 + height,
      tx_count: 1, size: 1000, weight: 4000, previousblockhash: '', extras: {} });
    // The backend seeds the tip with `blocks` on connect, then sends each next `block`.
    receiveWebSocketMessageFromServer({ params: { message: { contents: JSON.stringify({ blocks: [block(900006)] }) } } });
    cy.intercept('GET', '**/api/v1/supply/distribution', distribution(900001)).as('nextDistribution');
    receiveWebSocketMessageFromServer({ params: { message: { contents: JSON.stringify({ block: block(900007) }) } } });
    cy.wait('@nextDistribution', { timeout: 15000 });
    cy.get('[data-cy=supply-height]').should('contain', '900,001');
  });

  it('explains when no snapshot has been loaded yet', () => {
    enableSupply();
    cy.intercept('GET', '**/api/v1/supply/distribution', { statusCode: 404, body: { error: 'no_data' } });
    cy.intercept('GET', '**/api/v1/supply/top-addresses*', { statusCode: 404, body: { error: 'no_data' } });
    cy.visit('/supply');
    cy.get('[data-cy=supply-no-data]').should('be.visible');
  });

  it('shows the stale notice while keeping the last figures', () => {
    enableSupply();
    cy.intercept('GET', '**/api/v1/supply/distribution', { ...distribution(), status: 'stale' });
    cy.visit('/supply');
    cy.get('[data-cy=supply-status-stale]').should('contain', '900000');
    cy.get('[data-cy=supply-buckets] tbody tr').should('have.length', 10);
  });

  it('hides the navigation entry when disabled', () => {
    enableSupply(false);
    cy.visit('/');
    cy.get('#btn-graphs').should('be.visible');
    cy.get('#btn-supply').should('not.exist');
    cy.get('@distribution.all').should('have.length', 0);
  });
});

describe('Supply rank on the address page', () => {
  const address = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
  const stats = { funded_txo_count: 1, funded_txo_sum: 300_000, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 1 };

  beforeEach(() => {
    cy.on('window:before:load', (win) => {
      win['__env'] = { MINING_DASHBOARD: false, HISTORICAL_PRICE: false, PURITY_NODES_MAP_ENABLED: false, CORE_TIP_HEIGHT_API: '', CORE_TX_API: '' };
    });
    cy.mockMempoolSocket();
    enableSupply();
    cy.intercept('GET', `**/api/address/${address}`, { address, chain_stats: stats, mempool_stats: { ...stats, funded_txo_count: 0, funded_txo_sum: 0, tx_count: 0 } });
    cy.intercept('GET', `**/api/address/${address}/txs*`, []);
  });

  it('shows the rank for a top address and links to its page', () => {
    cy.intercept('GET', `**/api/v1/supply/address/${address}`, { ...state, rank: 150, topN: 10000, balance: 300_000, utxoCount: 1, share: 0.0001 }).as('rank');
    cy.visit(`/address/${address}`);
    cy.wait('@rank');
    cy.get('[data-cy=supply-rank]').should('contain', '#150').and('contain', '0.01').and('contain', '900,000');
    cy.get('[data-cy=supply-rank] a').should('have.attr', 'href', '/supply?page=2');
  });

  it('hides the row when the address is not ranked', () => {
    cy.intercept('GET', `**/api/v1/supply/address/${address}`, { statusCode: 404, body: { error: 'not_ranked' } }).as('rank');
    cy.visit(`/address/${address}`);
    cy.wait('@rank');
    cy.get('[data-cy=supply-rank]').should('not.exist');
  });
});
