const { fetchStations } = require('./fetch');

function createPlenergyCollector(options = {}) {
  return {
    name: 'plenergy',
    country: 'ES',
    async fetch(context = {}) {
      const reportProgress =
        typeof context?.reportProgress === 'function' ? context.reportProgress : () => {};
      return fetchStations(options, { reportProgress });
    },
  };
}

module.exports = {
  createPlenergyCollector,
};
