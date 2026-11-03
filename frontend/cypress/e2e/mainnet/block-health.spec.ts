describe('Lightweight block Health', () => {
  for (const score of [100, 0, null]) {
    it(`shows ${score ?? 'Unknown'} without a GBT template`, () => {
      cy.on('window:before:load', win => {
        win['__env'] = { AUDIT: true, MINING_DASHBOARD: true, MAINNET_BLOCK_AUDIT_START_HEIGHT: 0,
          HISTORICAL_PRICE: false, PURITY_NODES_MAP_ENABLED: false, CORE_TIP_HEIGHT_API: '', CORE_TX_API: '' };
      });
      cy.mockMempoolSocketV2();
      cy.intercept('GET', '**/resources/config.js', { body: 'window.__env = window.__env || {};',
        headers: { 'content-type': 'application/javascript' } });
      cy.fixture('mainnet_mempoolInfo.json').then(data => {
        const block = { ...data.blocks[0], previousblockhash: null, extras: { ...data.blocks[0].extras, matchRate: score } };
        cy.intercept('GET', '**/api/v1/init-data', { body: { ...data, blocks: [block] } });
        cy.intercept('GET', `**/api/v1/block/${block.id}`, { body: block });
        cy.intercept('GET', `**/api/v1/block/${block.id}/summary`, { body: [] });
        cy.intercept('GET', `**/api/v1/block/${block.id}/audit-summary`, { statusCode: 404, body: { error: 'Audit not available' } }).as('audit');
        cy.intercept('GET', `**/api/block/${block.id}/txs*`, { body: [] });
        cy.intercept('GET', `**/api/block/${block.id}/txs/**`, { body: [] });
        cy.visit(`/block/${block.id}?view=actual`);
        cy.wait('@audit');
        cy.get('[data-cy="block-health"]').should('contain', score == null ? 'Unknown' : `${score}%`);
        cy.get('[data-cy="block-health"] .skeleton-loader').should('not.exist');
      });
    });
  }
});
