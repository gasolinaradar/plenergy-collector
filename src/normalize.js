const decimalCommaRegex = /,/g;

function normalizePrice(value) {
  if (value === null || value === undefined) return null;
  const raw = typeof value === 'number' ? value.toString() : value.trim();
  if (!raw) return null;
  const normalized = raw.replace(decimalCommaRegex, '.');
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCoordinate(value) {
  if (value === null || value === undefined) {
    throw new Error('Missing coordinate value');
  }

  const raw = typeof value === 'number' ? value.toString() : String(value).trim();
  if (!raw) {
    throw new Error('Empty coordinate value');
  }

  const normalized = raw.replace(decimalCommaRegex, '.');
  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid coordinate value: ${value}`);
  }

  return parsed;
}

function slugifyFuelName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, '');
}

const SERVICE_MAPPINGS = [
  { key: 'surtidores', label: 'fuel_pumps' },
  { key: 'lavaderos', label: 'car_wash' },
  { key: 'aspiradores', label: 'vacuum_cleaners' },
  { key: 'cargadores', label: 'ev_chargers' },
  { key: 'aireagua', label: 'air_and_water' },
];

const PRICE_EXCLUDE_KEYS = new Set(['preciariolavadero']);
const PRICE_COLUMN_PATTERN = String.raw`id="(col(?:Movil|Escritorio)[^"]+)"[\s\S]*?<h[34][^>]*>([\s\S]*?)</h[34]>[\s\S]*?<h[34][^>]*>([\s\S]*?)</h[34]>`;

function normalizeServices(station) {
  const services = SERVICE_MAPPINGS.reduce((acc, mapping) => {
    const value = station[mapping.key];
    if (value === undefined || value === null) {
      return acc;
    }

    const numeric = Number.parseInt(String(value), 10);
    if (Number.isFinite(numeric) && numeric > 0) {
      acc.push(mapping.label);
    }

    return acc;
  }, []);

  return services.length > 0 ? services : undefined;
}

function normalizeSchedule(station) {
  if (String(station.es24h ?? '').trim() === '1') {
    return '24h';
  }

  const segments = [station.horario1_es, station.horario2_es]
    .map((segment) => (typeof segment === 'string' ? segment.trim() : ''))
    .filter(Boolean);

  if (segments.length === 0) {
    return undefined;
  }

  return segments.join(' | ');
}

function normalizePrices(station) {
  const prices = Object.entries(station).reduce((acc, [key, value]) => {
    const lowerKey = key.toLowerCase();

    if (value === undefined || value === null || PRICE_EXCLUDE_KEYS.has(lowerKey)) {
      return acc;
    }

    if (typeof value !== 'string' && typeof value !== 'number') {
      return acc;
    }

    const isPriceField = lowerKey.includes('precio') || lowerKey.startsWith('pvp');
    if (!isPriceField) {
      return acc;
    }

    const amount = normalizePrice(value);
    if (amount === null) {
      return acc;
    }

    const slug = slugifyFuelName(key.replace(/precio/gi, '').replace(/pvp/gi, ''));
    if (!slug) {
      return acc;
    }

    acc[slug] = amount;
    return acc;
  }, {});

  return Object.keys(prices).length > 0 ? prices : undefined;
}

const HTML_ENTITY_MAP = {
  amp: '&',
  nbsp: ' ',
  euro: '€',
  aacute: 'á',
  eacute: 'é',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  ntilde: 'ñ',
  ccedil: 'ç',
};

function computeProgressPercent(current, total) {
  if (!Number.isFinite(total) || total <= 0) {
    return 100;
  }

  return Math.round((current / total) * 1000) / 10;
}

function decodeHtmlEntities(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return '';
  }

  return value
    .replace(/&#(\d+);/g, (_, code) => {
      const charCode = Number.parseInt(code, 10);
      return Number.isFinite(charCode) ? String.fromCharCode(charCode) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const charCode = Number.parseInt(hex, 16);
      return Number.isFinite(charCode) ? String.fromCharCode(charCode) : _;
    })
    .replace(/&([a-z]+);/gi, (match, entity) => {
      const normalized = entity.toLowerCase();
      return Object.prototype.hasOwnProperty.call(HTML_ENTITY_MAP, normalized)
        ? HTML_ENTITY_MAP[normalized]
        : match;
    });
}

function cleanHtmlText(value) {
  if (!value) {
    return '';
  }

  const withoutTags = value.replace(/<[^>]*>/g, ' ');
  const decoded = decodeHtmlEntities(withoutTags);
  return decoded.replace(/\s+/g, ' ').trim();
}

function extractPricesFromHtml(html) {
  const prices = {};
  if (typeof html !== 'string' || html.length === 0) {
    return prices;
  }

  const columnRegex = new RegExp(PRICE_COLUMN_PATTERN, 'gi');
  let match;
  while ((match = columnRegex.exec(html)) !== null) {
    const fuelName = cleanHtmlText(match[2]);
    if (!fuelName) {
      continue;
    }

    const slug = slugifyFuelName(fuelName);
    if (!slug || Object.prototype.hasOwnProperty.call(prices, slug)) {
      continue;
    }

    const priceText = cleanHtmlText(match[3]);
    if (!priceText) {
      continue;
    }

    const amount = normalizePrice(priceText);
    if (amount === null) {
      continue;
    }

    prices[slug] = amount;
  }

  return prices;
}

function hasPrices(prices) {
  return Boolean(prices && Object.keys(prices).length > 0);
}

function resolveName(station) {
  const candidates = [station.nombreweb, station.nombre];
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return 'Desconocido';
}

function normalizeRawStation(station) {
  const latitude = normalizeCoordinate(station.latitud);
  const longitude = normalizeCoordinate(station.longitud);

  const prices = normalizePrices(station);

  return {
    source: 'plenergy',
    country: 'ES',
    sourceStationId: String(station.id ?? station.slug ?? '').trim(),
    name: resolveName(station),
    address: station.direccion?.trim() ?? '',
    municipality: station.poblacion?.trim() ?? '',
    province: station.provincia?.trim() ?? '',
    postalCode: station.cpostal?.trim() || undefined,
    schedule: normalizeSchedule(station),
    services: normalizeServices(station),
    location: {
      type: 'Point',
      coordinates: [longitude, latitude],
    },
    prices,
    lastUpdated: new Date(),
  };
}

module.exports = {
  normalizePrice,
  normalizeCoordinate,
  slugifyFuelName,
  normalizeServices,
  normalizeSchedule,
  normalizePrices,
  decodeHtmlEntities,
  cleanHtmlText,
  extractPricesFromHtml,
  hasPrices,
  resolveName,
  normalizeRawStation,
  computeProgressPercent,
  SERVICE_MAPPINGS,
  PRICE_EXCLUDE_KEYS,
  PRICE_COLUMN_PATTERN,
  HTML_ENTITY_MAP,
};
