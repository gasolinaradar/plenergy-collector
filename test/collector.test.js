const { test } = require('node:test');
const assert = require('node:assert');
const { createPlenergyCollector, fetchStations } = require('../src');
const { normalizePrices, extractPricesFromHtml } = require('../src/normalize');
const { DEFAULT_PLENERGY_URL } = require('../src/fetch');

const silentLogger = { info: () => {}, warn: () => {}, debug: () => {} };

const STATION_A_URL = 'https://plenergy.es/estacion/1000';
const STATION_B_URL = 'https://plenergy.es/estacion/2000';

const SAMPLE_LIST_PAYLOAD = [
  {
    id: '1000',
    nombre: 'Estación A',
    direccion: 'Calle Mayor 1',
    poblacion: 'Madrid',
    provincia: 'Madrid',
    cpostal: '28013',
    latitud: '40.4168',
    longitud: '-3.7038',
    es24h: '1',
    surtidores: '4',
    lavaderos: '0',
    cargadores: '2',
    precioGasolina95: '1.759',
    precioGasoleoA: '1.489',
    urlweb: STATION_A_URL,
  },
  {
    id: '2000',
    nombre: 'Estación B',
    direccion: 'Av. Central 10',
    poblacion: 'Bilbao',
    provincia: 'Bizkaia',
    cpostal: '48001',
    latitud: '43.263',
    longitud: '-2.935',
    es24h: '0',
    horario1_es: '06:00-22:00',
    surtidores: '2',
    urlweb: STATION_B_URL,
  },
  {
    id: '3000',
    nombre: 'Estación C',
    direccion: 'Calle Sol 5',
    poblacion: 'Sevilla',
    provincia: 'Sevilla',
    cpostal: '41001',
    latitud: '37.389',
    longitud: '-5.984',
  },
];

const SAMPLE_STATION_PAGE_HTML = `<html>
  <body>
    <div id="colMovilGasoleoA" class="col">
      <h3>Gasoleo A</h3>
      <h4>1,629</h4>
    </div>
    <div id="colMovilGasolina95" class="col">
      <h3>Gasolina 95</h3>
      <h4>1,759</h4>
    </div>
  </body>
</html>`;

function createFakeClient(listPayload, htmlPages = {}) {
  const calls = [];
  const client = {
    calls,
    get: async (url) => {
      calls.push(url);
      if (url.includes('json.php')) {
        return { status: 200, data: listPayload };
      }
      return { status: 200, data: htmlPages[url] ?? '' };
    },
  };
  return client;
}

test('fetchStations returns normalized stations with JSON and scraped prices', async () => {
  const client = createFakeClient(SAMPLE_LIST_PAYLOAD, {
    [STATION_B_URL]: SAMPLE_STATION_PAGE_HTML,
  });
  const stations = await fetchStations({ httpClient: client, logger: silentLogger });

  assert.equal(stations.length, 3);

  const byId = Object.fromEntries(stations.map((station) => [station.sourceStationId, station]));
  const a = byId['1000'];
  const b = byId['2000'];
  const c = byId['3000'];
  assert.ok(a);
  assert.ok(b);
  assert.ok(c);
  assert.equal(a.source, 'plenergy');
  assert.equal(a.country, 'ES');
  assert.equal(a.sourceStationId, '1000');
  assert.equal(a.name, 'Estación A');
  assert.equal(a.address, 'Calle Mayor 1');
  assert.equal(a.municipality, 'Madrid');
  assert.equal(a.province, 'Madrid');
  assert.equal(a.postalCode, '28013');
  assert.equal(a.schedule, '24h');
  assert.deepEqual(a.services, ['fuel_pumps', 'ev_chargers']);
  assert.deepEqual(a.location, { type: 'Point', coordinates: [-3.7038, 40.4168] });
  assert.deepEqual(a.prices, { gasolina95: 1.759, gasoleoa: 1.489 });
  assert.ok(a.lastUpdated instanceof Date);

  assert.equal(b.sourceStationId, '2000');
  assert.equal(b.name, 'Estación B');
  assert.equal(b.schedule, '06:00-22:00');
  assert.deepEqual(b.services, ['fuel_pumps']);
  assert.deepEqual(b.prices, { gasoleoa: 1.629, gasolina95: 1.759 });

  assert.equal(c.sourceStationId, '3000');
  assert.equal(c.prices, undefined);
  assert.equal(c.services, undefined);
  assert.equal(c.schedule, undefined);
});

test('uses the default dataset URL when none is provided', async () => {
  const client = createFakeClient(SAMPLE_LIST_PAYLOAD);
  await fetchStations({ httpClient: client, logger: silentLogger });
  assert.equal(client.calls[0], DEFAULT_PLENERGY_URL);
});

test('createPlenergyCollector exposes the collector contract', async () => {
  const collector = createPlenergyCollector({
    httpClient: createFakeClient(SAMPLE_LIST_PAYLOAD),
    logger: silentLogger,
  });

  assert.equal(collector.name, 'plenergy');
  assert.equal(collector.country, 'ES');
  assert.equal(typeof collector.fetch, 'function');

  const stations = await collector.fetch({});
  assert.equal(stations.length, 3);
});

test('reports progress through the context hook', async () => {
  const collector = createPlenergyCollector({
    httpClient: createFakeClient(SAMPLE_LIST_PAYLOAD),
    logger: silentLogger,
  });
  const steps = [];

  const stations = await collector.fetch({
    reportProgress(percent, metadata = {}) {
      steps.push({ percent, metadata });
    },
  });

  assert.equal(stations.length, 3);
  assert.equal(steps[0].percent, 5);
  assert.equal(steps[0].metadata.stage, 'requesting_dataset');
  assert.ok(steps.some((step) => step.percent === 10 && step.metadata.stage === 'processing_dataset'));
  assert.ok(steps.some((step) => step.metadata.stage === 'processing_station'));
  assert.equal(steps[steps.length - 1].percent, 100);
  assert.equal(steps[steps.length - 1].metadata.stage, 'completed');
});

test('throws on unexpected dataset payload', async () => {
  const client = createFakeClient({ not: 'an array' });
  await assert.rejects(
    () => fetchStations({ httpClient: client, retries: 0, logger: silentLogger }),
    /Unexpected Plenergy response payload/,
  );
});

test('skips stations without coordinates', async () => {
  const list = [{ id: '900', nombre: 'Sin coords' }];
  const client = createFakeClient(list);
  const stations = await fetchStations({ httpClient: client, logger: silentLogger });
  assert.deepEqual(stations, []);
});

test('scrapes a shared station page only once', async () => {
  const shared = 'https://plenergy.es/estacion/compartida';
  const list = [
    { id: 'A1', nombre: 'A1', latitud: '40.1', longitud: '-3.1', urlweb: shared },
    { id: 'A2', nombre: 'A2', latitud: '40.2', longitud: '-3.2', urlweb: shared },
  ];
  const client = createFakeClient(list, { [shared]: SAMPLE_STATION_PAGE_HTML });
  const stations = await fetchStations({ httpClient: client, logger: silentLogger });

  assert.equal(stations.length, 2);
  assert.deepEqual(stations[0].prices, { gasoleoa: 1.629, gasolina95: 1.759 });
  assert.deepEqual(stations[1].prices, { gasoleoa: 1.629, gasolina95: 1.759 });

  const pageCalls = client.calls.filter((url) => url === shared);
  assert.equal(pageCalls.length, 1);
});

test('normalizePrices extracts precio/pvp fields as slugs', () => {
  assert.deepEqual(
    normalizePrices({
      precioGasolina95: '1,759',
      pvpGasoleoA: 1.489,
      preciariolavadero: '5',
      nombre: 'X',
    }),
    { gasolina95: 1.759, gasoleoa: 1.489 },
  );
  assert.equal(normalizePrices({ nombre: 'X' }), undefined);
});

test('extractPricesFromHtml parses station page price columns', () => {
  assert.deepEqual(extractPricesFromHtml(SAMPLE_STATION_PAGE_HTML), {
    gasoleoa: 1.629,
    gasolina95: 1.759,
  });
  assert.deepEqual(extractPricesFromHtml(''), {});
});
