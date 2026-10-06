const node = {
  host: '8.8.8.8', port: 8333, status: 'purity', p2p_reachable: 1,
  user_agent: '/Purity:1.0.0/', height: 962000,
  last_seen: 1700000000, last_success: 1700000000, last_p2p_success: 1700000000,
  location: { longitude: -74, latitude: 40.7, city: 'New York', country: 'United States', country_code: 'US' },
};
const snapshot = { updated_at: 1700000100, nodes: [node,
  { ...node, host: '1.1.1.1', p2p_reachable: 0, location: { ...node.location, longitude: 145, latitude: -38 } },
  { ...node, host: '2001:4860:4860::8888', p2p_reachable: null, location: null },
] };

describe('Purity node world map on the homepage', () => {
  beforeEach(() => {
    cy.on('window:before:load', win => {
      win['__env'] = { MINING_DASHBOARD: false, HISTORICAL_PRICE: false, CORE_TIP_HEIGHT_API: '', CORE_TX_API: '' };
    });
    cy.mockMempoolSocket();
    cy.intercept('GET', '**/resources/config.js', {
      body: 'window.__env = window.__env || {};', headers: { 'content-type': 'application/javascript' },
    });
    cy.intercept('GET', '**/api/v1/purity/nodes', snapshot).as('nodes');
  });

  function openForm(): void {
    cy.get('[data-cy=purity-add-toggle]').click();
    cy.get('[data-cy=purity-host]').type('8.8.8.8');
  }

  it('shows a full width map by default in place of Ocean and Knots and counts unlocated nodes', () => {
    cy.visit('/');
    cy.wait('@nodes');
    cy.get('[data-cy=purity-nodes]').should('be.visible');
    cy.get('app-ocean-hashrate-chart, app-knots-nodes-chart').should('not.exist');
    cy.get('[data-cy=purity-total]').should('contain', '3');
    cy.get('[data-cy=purity-public]').should('contain', '1');
    cy.get('[data-cy=purity-non-public]').should('contain', '2');
    cy.get('[data-cy=purity-unlocated]').should('contain', '1');
    cy.get('[data-cy=purity-chart] svg').should('exist');
    cy.get('[data-cy=purity-chart] svg path[fill="#37c89b"]').should('have.length', 1);
    cy.get('[data-cy=purity-chart] svg path[stroke="#f2b75a"]').should('have.length', 1);
    cy.get('[data-cy=purity-nodes]').should('contain', 'Seeder');
    cy.get('[data-cy=purity-nodes]').then($card => {
      expect($card[0].getBoundingClientRect().width).to.be.greaterThan(800);
    });
  });

  it('shows the map when explicitly enabled in runtime configuration', () => {
    cy.intercept('GET', '**/resources/config.js', {
      body: 'window.__env.PURITY_NODES_MAP_ENABLED = true;', headers: { 'content-type': 'application/javascript' },
    });
    cy.visit('/');
    cy.wait('@nodes');
    cy.get('app-purity-nodes-map').should('be.visible');
  });

  it('hides the entire map and makes no node requests when disabled', () => {
    cy.clock(Date.now(), ['setInterval', 'clearInterval']);
    cy.intercept('GET', '**/resources/config.js', {
      body: 'window.__env.PURITY_NODES_MAP_ENABLED = false;', headers: { 'content-type': 'application/javascript' },
    });
    cy.visit('/');
    cy.tick(0);
    cy.get('app-dashboard').should('exist');
    cy.get('app-purity-nodes-map, [data-cy=purity-add-toggle]').should('not.exist');
    cy.tick(120000);
    cy.get('@nodes.all').should('have.length', 0);
    cy.get('app-ocean-hashrate-chart, app-knots-nodes-chart').should('not.exist');
  });

  it('renders both map categories and exposes failure vs unknown as text', () => {
    cy.visit('/');
    cy.wait('@nodes');
    cy.get('[data-cy=purity-node-list-toggle]').click();
    cy.get('[data-cy=purity-node-list]').should('contain', 'Recent probe failed').and('contain', 'Not yet probed');
    cy.get('[data-cy=purity-node-list]').should('contain', '[2001:4860:4860::8888]:8333');
    cy.get('[data-cy=purity-chart] svg path[fill="#37c89b"]').click({ force: true });
    cy.get('.node-detail').should('contain', '8.8.8.8:8333').and('contain', '/Purity:1.0.0/');
    cy.get('[data-cy=purity-public]').click().should('have.attr', 'aria-pressed', 'false');
    cy.get('[data-cy=purity-chart] svg path[fill="#37c89b"]').should('not.exist');
    cy.get('[data-cy=purity-chart] svg path[stroke="#f2b75a"]').should('have.length', 1);
  });

  it('refreshes the inventory every 60 seconds', () => {
    cy.clock(Date.now(), ['setInterval', 'clearInterval']);
    cy.visit('/');
    cy.tick(0);
    cy.wait('@nodes');
    cy.intercept('GET', '**/api/v1/purity/nodes', { ...snapshot, nodes: [node] }).as('periodic');
    cy.tick(60000);
    cy.wait('@periodic');
    cy.get('[data-cy=purity-total]').should('contain', '1');
  });

  it('rejects a hostname in the form and submits an IPv6 address', () => {
    cy.intercept('POST', '**/api/v1/purity/nodes', { body: {
      host: '2001:4860:4860::8888', port: 8333, added: true, verification: 'purity', status: 'purity',
    } }).as('add');
    cy.visit('/');
    cy.wait('@nodes');
    cy.get('[data-cy=purity-add-toggle]').click();
    cy.get('[data-cy=purity-submit]').should('be.disabled');
    cy.get('[data-cy=purity-host]').type('example.org');
    cy.get('[data-cy=purity-submit]').should('be.disabled');
    cy.get('[data-cy=purity-host]').clear().type('2001:4860:4860::8888');
    cy.get('[data-cy=purity-submit]').click();
    cy.wait('@add').its('request.body').should('deep.equal', { host: '2001:4860:4860::8888', port: 8333 });
    cy.get('[data-cy=purity-add-result]').should('contain', '[2001:4860:4860::8888]:8333');
  });

  it('validates a form and prevents repeated submissions while verification is pending', () => {
    cy.intercept('POST', '**/api/v1/purity/nodes', { delay: 500, body: {
      host: '8.8.8.8', port: 8333, added: true, verification: 'purity', status: 'purity',
    } }).as('add');
    cy.visit('/');
    cy.wait('@nodes');
    openForm();
    cy.get('[data-cy=purity-port]').clear().type('65536');
    cy.get('[data-cy=purity-submit]').should('be.disabled');
    cy.get('[data-cy=purity-port]').clear();
    cy.get('[data-cy=purity-submit]').click().should('be.disabled');
    cy.wait('@add').its('request.body').should('deep.equal', { host: '8.8.8.8' });
    cy.wait('@nodes');
    cy.get('[data-cy=purity-add-result]').should('contain', 'Purity node confirmed');
  });

  for (const verification of ['purity', 'other', 'inconclusive']) {
    it(`shows ${verification} and duplicate verification without treating it as an insertion failure`, () => {
      cy.intercept('POST', '**/api/v1/purity/nodes', { body: {
        host: '8.8.8.8', port: 8333, added: false, verification, status: verification === 'other' ? 'other' : 'purity',
      } }).as('add');
      cy.visit('/');
      cy.wait('@nodes');
      openForm();
      cy.get('[data-cy=purity-submit]').click();
      cy.wait('@add');
      cy.wait('@nodes');
      cy.get('[data-cy=purity-add-result]').should('contain', 'already exists');
      cy.get('[data-cy=purity-add-result]').should('contain', verification === 'purity' ? 'Purity node confirmed' :
        verification === 'other' ? 'not a Purity node' : 'Verification was inconclusive');
    });
  }

  it('refreshes the map after a newly confirmed submission', () => {
    cy.intercept('POST', '**/api/v1/purity/nodes', { body: {
      host: '8.8.8.8', port: 8333, added: true, verification: 'purity', status: 'purity',
    } }).as('add');
    cy.visit('/');
    cy.wait('@nodes');
    cy.intercept('GET', '**/api/v1/purity/nodes', { ...snapshot, nodes: [...snapshot.nodes, { ...node, port: 8334 }] }).as('refreshed');
    openForm();
    cy.get('[data-cy=purity-submit]').click();
    cy.wait('@add');
    cy.wait('@refreshed');
    cy.get('[data-cy=purity-total]').should('contain', '4');
  });

  it('reports an ambiguous timeout and does not retry the POST', () => {
    let writes = 0;
    cy.intercept('POST', '**/api/v1/purity/nodes', req => {
      writes++;
      req.reply({ statusCode: 504, body: { error: 'verification_timeout' } });
    }).as('add');
    cy.visit('/');
    cy.wait('@nodes');
    openForm();
    cy.get('[data-cy=purity-submit]').click();
    cy.wait('@add');
    cy.get('[data-cy=purity-add-result]').should('contain', 'has not returned');
    cy.then(() => expect(writes).to.equal(1));
  });

  it('offers a retry on read errors rather than claiming an empty inventory', () => {
    cy.intercept('GET', '**/api/v1/purity/nodes', { statusCode: 503, body: { error: 'seeder_not_configured' } }).as('unavailable');
    cy.visit('/');
    cy.wait('@unavailable');
    cy.get('[data-cy=purity-load-error]').should('be.visible');
    cy.intercept('GET', '**/api/v1/purity/nodes', snapshot).as('retry');
    cy.get('[data-cy=purity-retry]').click();
    cy.wait('@retry');
    cy.get('[data-cy=purity-total]').should('contain', '3');
  });

  it('fits the mobile viewport', () => {
    cy.viewport(390, 844);
    cy.visit('/');
    cy.wait('@nodes');
    cy.get('[data-cy=purity-nodes]').should('be.visible').then($card => {
      expect($card[0].getBoundingClientRect().right).to.be.at.most(390);
    });
    openForm();
    cy.get('[data-cy=purity-submit]').should('be.visible');
    cy.get('[data-cy=purity-host]').then($field => {
      expect($field[0].getBoundingClientRect().right).to.be.at.most(390);
    });
  });
});
