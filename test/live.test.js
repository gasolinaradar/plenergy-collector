const { test, before } = require('node:test');
const assert = require('node:assert');
const axios = require('axios');
const {
  fetchRawStations,
  fetchPricesFromWebsite,
  DEFAULT_PLENERGY_URL,
} = require('../src/fetch');
const { normalizeRawStation, hasPrices } = require('../src/normalize');

const silentLogger = { info: () => {}, warn: () => {}, debug: () => {} };
const TIMEOUT = 30000;
const SAMPLE_SIZE = 5;

const SPAIN_LATITUDE_RANGE = [27, 44];
const SPAIN_LONGITUDE_RANGE = [-18.5, 4.5];

const REAL_PAGE_FUEL_SLUGS = ['disel', 'diselplus', 'sp95', 'sp95plus'];

let raw;
let normalized;
let scrapedPages;

before(async () => {
  raw = await fetchRawStations(axios, silentLogger, DEFAULT_PLENERGY_URL, TIMEOUT);
  normalized = raw
    .map((station) => {
      try {
        return normalizeRawStation(station);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const stationsWithUrl = raw.filter(
    (station) => typeof station.urlweb === 'string' && station.urlweb.trim(),
  );
  scrapedPages = await Promise.all(
    stationsWithUrl.slice(0, SAMPLE_SIZE).map((station) =>
      fetchPricesFromWebsite(axios, silentLogger, station.urlweb.trim(), TIMEOUT).then((prices) => ({
        url: station.urlweb.trim(),
        prices,
      })),
    ),
  );
});

test('real Plenergy API: dataset normalizes into stations', () => {
  assert.ok(raw.length > 0, `expected stations in the dataset, got ${raw.length}`);
  assert.ok(normalized.length > 0, `expected normalizable stations, got ${normalized.length}`);

  const sample = normalized[0];
  assert.equal(sample.source, 'plenergy');
  assert.equal(sample.country, 'ES');
  assert.ok(sample.sourceStationId, 'station should have a source id');
  assert.ok(sample.name, 'station should have a name');
  assert.ok(Number.isFinite(sample.location?.coordinates?.[0]));
  assert.ok(Number.isFinite(sample.location?.coordinates?.[1]));
  assert.ok(sample.lastUpdated instanceof Date);
});

test('real Plenergy API: every station has the required shape', () => {
  for (const station of normalized) {
    assert.equal(station.source, 'plenergy', `wrong source for ${station.sourceStationId}`);
    assert.equal(station.country, 'ES', `wrong country for ${station.sourceStationId}`);
    assert.ok(station.sourceStationId, `missing source id for ${station.sourceStationId}`);
    assert.ok(station.name, `missing name for ${station.sourceStationId}`);
    assert.ok(Number.isFinite(station.location?.coordinates?.[0]));
    assert.ok(Number.isFinite(station.location?.coordinates?.[1]));
    assert.ok(station.lastUpdated instanceof Date);
  }
});

test('real Plenergy API: coordinates fall within Spain', () => {
  for (const station of normalized) {
    const [lon, lat] = station.location.coordinates;
    assert.ok(
      lat >= SPAIN_LATITUDE_RANGE[0] && lat <= SPAIN_LATITUDE_RANGE[1],
      `latitude out of Spain range for ${station.sourceStationId}: ${lat}`,
    );
    assert.ok(
      lon >= SPAIN_LONGITUDE_RANGE[0] && lon <= SPAIN_LONGITUDE_RANGE[1],
      `longitude out of Spain range for ${station.sourceStationId}: ${lon}`,
    );
  }
});

test('real Plenergy API: no duplicate source station ids', () => {
  const ids = normalized.map((station) => station.sourceStationId);
  assert.equal(new Set(ids).size, ids.length, 'sourceStationId must be unique');
});

test('real Plenergy API: station pages are scraped into positive prices', () => {
  const withPrices = scrapedPages.filter(({ prices }) => hasPrices(prices));
  assert.ok(
    withPrices.length > 0,
    'expected at least one real station page to expose prices',
  );

  for (const { prices } of withPrices) {
    assert.ok(Object.keys(prices).length > 0);
    for (const value of Object.values(prices)) {
      assert.ok(typeof value === 'number' && value > 0, `expected a positive price, got ${value}`);
    }
  }
});

test('real Plenergy API: scraped fuel slugs follow the real page vocabulary', () => {
  const withPrices = scrapedPages.filter(({ prices }) => hasPrices(prices));
  assert.ok(withPrices.length > 0, 'expected at least one real station page with prices');

  const seen = new Set();
  for (const { prices } of withPrices) {
    for (const key of Object.keys(prices)) {
      assert.match(key, /^[a-z0-9]+$/, `unexpected fuel slug: ${key}`);
      seen.add(key);
    }
  }

  assert.ok(
    seen.has('disel'),
    `expected the real page diesel slug ("disel") among ${[...seen].join(', ')}`,
  );

  for (const key of seen) {
    assert.ok(
      REAL_PAGE_FUEL_SLUGS.includes(key),
      `fuel slug "${key}" is not part of the expected Plenergy vocabulary ${JSON.stringify(REAL_PAGE_FUEL_SLUGS)}`,
    );
  }
});
