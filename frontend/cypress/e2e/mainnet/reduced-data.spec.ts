describe('Purity reduced-data enforcement and historical analysis', () => {
  const status = { state: 'active', permanent: true, currentHeight: 968113, activationHeight: 961637, expiryHeight: null };

  beforeEach(() => {
    cy.on('window:before:load', win => {
      win['__env'] = { MINING_DASHBOARD: false, HISTORICAL_PRICE: false, PURITY_NODES_MAP_ENABLED: false,
        CORE_TIP_HEIGHT_API: '', CORE_TX_API: '' };
    });
    cy.mockMempoolSocket();
    cy.intercept('GET', '**/resources/config.js', {
      body: 'window.__env = window.__env || {};', headers: { 'content-type': 'application/javascript' },
    });
    cy.intercept('GET', '**/api/v1/init-data', { fixture: 'mainnet_mempoolInfo.json' });
    cy.visit('/');
    cy.window().should(win => expect(win.mockSocket).not.to.be.undefined);
  });

  function send(data: unknown): void {
    cy.window().then(win => win.mockSocket.send(JSON.stringify(data)));
  }

  it('renders permanent enforcement without deployment or expiry countdowns', () => {
    send({ bip110deployment: status });
    cy.get('app-bip110-deployment').should('contain', 'BIP-110 Reduced Data Rules')
      .and('contain', 'Permanently Enforced').and('contain', 'Bitcoin Purity consensus rules')
      .and('contain', '961,637').and('contain', 'Expiration').and('contain', 'None');
    cy.get('app-bip110-deployment').should('not.contain', 'EXPIRED').and('not.contain', 'Signaling')
      .and('not.contain', 'Blocks remaining').and('not.contain', '55%');
    cy.get('app-bip110-deployment .threshold-line, app-bip110-deployment .progress-bar-container').should('not.exist');
  });

  it('does not show an unverified activation height', () => {
    send({ bip110deployment: { ...status, activationHeight: null } });
    cy.get('app-bip110-deployment').should('contain', 'Permanently Enforced').and('not.contain', 'Activation height');
  });

  it('updates from before activation to permanent enforcement and stays active beyond the old expiry', () => {
    send({ bip110deployment: { ...status, state: 'not_active', currentHeight: 961636 } });
    cy.get('app-bip110-deployment').should('contain', 'Not Yet Enforced').and('not.contain', 'Permanently Enforced');
    send({ bip110deployment: { ...status, currentHeight: 961637 } });
    cy.get('app-bip110-deployment').should('contain', 'Permanently Enforced');
    send({ bip110deployment: { ...status, currentHeight: 2000000 } });
    cy.get('app-bip110-deployment').should('contain', 'Permanently Enforced').and('not.contain', 'EXPIRED');
  });

  it('keeps the separate historical violation scan progress', () => {
    send({ bip110deployment: status, loadingIndicators: { 'bip110-scan': 42 } });
    cy.get('app-bip110-deployment .scan-progress').should('contain', '42%');
    send({ loadingIndicators: { 'bip110-scan': 100 } });
    cy.get('app-bip110-deployment .scan-progress').should('not.exist');
    cy.get('app-bip110-deployment').should('contain', 'Permanently Enforced');
  });

  it('preserves historical block violation badges while permanent rules are displayed', () => {
    cy.fixture('mainnet_mempoolInfo.json').then(data => {
      const block = { ...data.blocks[0], extras: { ...data.blocks[0].extras,
        bip110ViolationCount: 2, bip110ViolationWeight: 1200 } };
      send({ ...data, blocks: [block], bip110deployment: status });
      cy.get('.badge-bip110-violation-mini').should('contain', '2');
      cy.get('.bitcoin-block.bip110-violations').should('exist');
      cy.get('app-bip110-deployment').should('contain', 'Permanently Enforced');
    });
  });
});
