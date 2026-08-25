/**
 * Local UI preview: serve frontend locally, proxy API/WS to mempool.bitcoinpurity.org.
 */
const TARGET = 'https://mempool.bitcoinpurity.org';

module.exports = [
  {
    context: [
      '*',
      '/api/**', '!/api/v1/ws',
      '!/liquid', '!/liquid/**', '!/liquid/',
      '!/liquidtestnet', '!/liquidtestnet/**', '!/liquidtestnet/',
      '/testnet/api/**', '/signet/api/**', '/testnet4/api/**', '/regtest/api/**',
    ],
    target: TARGET,
    ws: true,
    secure: true,
    changeOrigin: true,
  },
  {
    context: ['/api/v1/ws'],
    target: TARGET,
    ws: true,
    secure: true,
    changeOrigin: true,
  },
  {
    context: ['/resources/mining-pools/**'],
    target: TARGET,
    secure: true,
    changeOrigin: true,
  },
  {
    context: ['/resources/assets.json', '/resources/assets.minimal.json', '/resources/worldmap.json'],
    target: TARGET,
    secure: true,
    changeOrigin: true,
  },
];
