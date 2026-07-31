const axios = require('axios');
const { normalizeRawStation, extractPricesFromHtml, hasPrices, computeProgressPercent } =
  require('./normalize');
const { retry } = require('./retry');

const DEFAULT_PLENERGY_URL = 'https://plenergy.es/estaciones_datos/json.php';
const DEFAULT_PLENERGY_SCRAPE_CONCURRENCY = 4;
const DEFAULT_TIMEOUT = 15000;
const DEFAULT_RETRIES = 3;

function resolveLogger(loggerOption) {
  return loggerOption && typeof loggerOption.info === 'function' ? loggerOption : console;
}

function resolveHttpClient(httpClientOption) {
  return httpClientOption && typeof httpClientOption.get === 'function' ? httpClientOption : axios;
}

function resolveUrl(urlOption, fallback) {
  const value = typeof urlOption === 'function' ? urlOption() : urlOption;
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function resolveConcurrency(concurrencyOption, fallback) {
  const value =
    typeof concurrencyOption === 'function' ? concurrencyOption() : concurrencyOption;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createTaskQueue(concurrency) {
  const limit = Number.isFinite(concurrency) && concurrency > 0 ? Math.floor(concurrency) : 1;
  let activeCount = 0;
  const queue = [];

  const next = () => {
    if (activeCount >= limit) {
      return;
    }

    const item = queue.shift();
    if (!item) {
      return;
    }

    activeCount += 1;
    const { task, resolve, reject } = item;

    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        activeCount -= 1;
        next();
      });
  };

  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      if (activeCount < limit) {
        next();
      }
    });
}

async function fetchRawStations(httpClient, logger, url, timeout) {
  logger.info('Requesting Plenergy station dataset', { url });
  const response = await httpClient.get(url, { timeout });

  if (!Array.isArray(response.data)) {
    throw new Error('Unexpected Plenergy response payload');
  }

  logger.info('Received Plenergy station dataset', {
    url,
    status: response.status,
    stationCount: response.data.length,
  });

  return response.data;
}

async function fetchPricesFromWebsite(httpClient, logger, url, timeout) {
  if (!url) {
    return {};
  }

  try {
    logger.info('Requesting Plenergy station page', { url });
    const response = await httpClient.get(url, { timeout });
    logger.info('Received Plenergy station page response', {
      url,
      status: response.status,
      hasHtml: typeof response.data === 'string' && response.data.length > 0,
    });
    if (!response.data || typeof response.data !== 'string') {
      return {};
    }

    return extractPricesFromHtml(response.data);
  } catch (error) {
    logger.warn('Failed to fetch Plenergy station page for prices', {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

async function fetchStations(options = {}, hooks = {}) {
  const logger = resolveLogger(options.logger);
  const httpClient = resolveHttpClient(options.httpClient);
  const url = resolveUrl(options.url, DEFAULT_PLENERGY_URL);
  const scrapeConcurrency = resolveConcurrency(
    options.scrapeConcurrency,
    DEFAULT_PLENERGY_SCRAPE_CONCURRENCY,
  );
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const reportProgress =
    typeof hooks.reportProgress === 'function' ? hooks.reportProgress : () => {};

  logger.info('Starting Plenergy collector fetch');
  reportProgress(5, { stage: 'requesting_dataset' });
  const rawStations = await retry(() => fetchRawStations(httpClient, logger, url, timeout), {
    retries,
    minTimeoutMs: 1000,
    logger,
  });
  const totalStations = rawStations.length;
  reportProgress(10, { stage: 'processing_dataset', stationCount: totalStations });

  const stations = [];
  const priceCache = new Map();
  let scrapedPages = 0;
  let activeScrapes = 0;
  let processedStations = 0;

  const enqueueStation = createTaskQueue(scrapeConcurrency);

  const stationTasks = rawStations.map((rawStation, index) =>
    enqueueStation(async () => {
      const stationIndex = index + 1;
      const logProgressPercent = computeProgressPercent(stationIndex, totalStations);
      logger.info('Plenergy collector station progress', {
        stationIndex,
        totalStations,
        progressPercent: logProgressPercent,
      });

      try {
        const normalized = normalizeRawStation(rawStation);
        if (!normalized.sourceStationId) {
          throw new Error('Missing station identifier');
        }

        if (!hasPrices(normalized.prices)) {
          const stationUrl = typeof rawStation.urlweb === 'string' ? rawStation.urlweb.trim() : '';
          if (stationUrl) {
            let cachedPrices = priceCache.get(stationUrl);
            if (!cachedPrices) {
              const scrapeIndex = scrapedPages + activeScrapes + 1;
              const scrapedPercent = computeProgressPercent(scrapeIndex, totalStations);
              logger.info('Scraping Plenergy station page for prices', {
                stationId: normalized.sourceStationId,
                stationIndex,
                totalStations,
                progressPercent: logProgressPercent,
                scrapedPages: scrapeIndex,
                scrapedPercent,
                url: stationUrl,
                concurrency: scrapeConcurrency,
              });
              logger.debug('Fetching Plenergy prices from page', {
                stationId: normalized.sourceStationId,
                url: stationUrl,
              });

              activeScrapes += 1;
              cachedPrices = (async () => {
                try {
                  return await fetchPricesFromWebsite(httpClient, logger, stationUrl, timeout);
                } finally {
                  scrapedPages += 1;
                  activeScrapes -= 1;
                }
              })();
              cachedPrices = cachedPrices.then((result) => {
                priceCache.set(stationUrl, result);
                return result;
              });
              priceCache.set(stationUrl, cachedPrices);
            } else {
              logger.debug('Using cached Plenergy station page prices', {
                stationId: normalized.sourceStationId,
                url: stationUrl,
                priceCount:
                  typeof cachedPrices.then === 'function'
                    ? undefined
                    : Object.keys(cachedPrices).length,
              });
            }

            const resolvedPrices = await cachedPrices;
            if (hasPrices(resolvedPrices)) {
              normalized.prices = { ...resolvedPrices };
            }
          }
        }

        if (!hasPrices(normalized.prices)) {
          normalized.prices = undefined;
        }

        stations.push(normalized);
      } catch (error) {
        logger.warn('Skipping Plenergy station due to normalization error', {
          error: error instanceof Error ? error.message : String(error),
          stationId: rawStation?.id ?? rawStation?.slug,
        });
      } finally {
        processedStations += 1;
        const progressPercent = computeProgressPercent(processedStations, totalStations);
        reportProgress(progressPercent, {
          stage: 'processing_station',
          stationIndex,
          totalStations,
          scrapedPages,
          processedStations,
        });
      }
    }),
  );

  await Promise.all(stationTasks);

  logger.info('Fetched Plenergy stations', {
    rawCount: rawStations.length,
    stationCount: stations.length,
  });
  reportProgress(100, {
    stage: 'completed',
    rawCount: rawStations.length,
    stationCount: stations.length,
  });
  return stations;
}

module.exports = {
  fetchStations,
  fetchRawStations,
  fetchPricesFromWebsite,
  createTaskQueue,
  DEFAULT_PLENERGY_URL,
  DEFAULT_PLENERGY_SCRAPE_CONCURRENCY,
};
