# @gasolinaradar/plenergy-collector

<!-- EN -->

A Node.js collector for the **Plenergy fuel station dataset** (Spain). It downloads the public station list from `plenergy.es`, normalizes every station, and — when a station has no prices in the list — **scrapes the station's own page** to recover its fuel prices. It returns a **normalized, ready-to-use** array of fuel stations.

<!-- ES -->

Collector de Node.js para el **dataset de estaciones de servicio de Plenergy** (España). Descarga el listado público de estaciones de `plenergy.es`, normaliza cada estación y — cuando una estación no trae precios en el listado — **hace scraping de la página propia de la estación** para recuperar sus precios de combustible. Devuelve un array de estaciones **normalizado y listo para usar**.

---

## Features / Características

**EN:**

- Official Plenergy public source (Spain).
- Normalizes names, addresses, coordinates, schedule and services.
- Slugs fuel names from JSON price fields (`precioGasolina95` → `gasolina95`).
- Automatically scrapes the station page when the list payload has no prices, with a concurrency limit (default 4) and per-URL caching.
- Extracts prices from the station page HTML (entity decoding, tag cleaning, decimal commas).
- Built-in retry with exponential backoff for the dataset request.
- Injectable logger, HTTP client, and concurrency.
- Progress reporting hook for long runs.
- Zero configuration: works with sensible defaults. The library resolves the dataset URL and every page URL itself.

**ES:**

- Fuente pública oficial de Plenergy (España).
- Normaliza nombres, direcciones, coordenadas, horarios y servicios.
- Slugifica los nombres de combustible de los campos de precio del JSON (`precioGasolina95` → `gasolina95`).
- Hace scraping automático de la página de la estación cuando el listado no trae precios, con límite de concurrencia (por defecto 4) y caché por URL.
- Extrae los precios del HTML de la página (decodificación de entidades, limpieza de etiquetas, comas decimales).
- Reintentos con backoff exponencial integrados para la petición del dataset.
- Logger, cliente HTTP y concurrencia inyectables.
- Hook de reporte de progreso para ejecuciones largas.
- Cero configuración: funciona con valores por defecto sensatos. La librería resuelve por sí misma la URL del dataset y la de cada página.

---

## Installation / Instalación

```bash
npm install @gasolinaradar/plenergy-collector
```

---

## Quick start / Inicio rápido

```js
const { fetchStations } = require('@gasolinaradar/plenergy-collector');

async function main() {
  const stations = await fetchStations();
  console.log(`Fetched ${stations.length} fuel stations`);
  console.log(stations[0]);
}

main();
```

---

## API

### `fetchStations(options?) → Promise<Station[]>`

Downloads the dataset, normalizes every station (scraping missing prices from each station page) and returns the normalized stations in one step.

```js
const { fetchStations } = require('@gasolinaradar/plenergy-collector');

const stations = await fetchStations({
  scrapeConcurrency: 4,
  logger: console,
  timeout: 15000,
  retries: 3,
});
```

### `createPlenergyCollector(options?) → Collector`

Returns an object matching the common **collector contract** used by ingestion pipelines:

```js
{ name: 'plenergy', country: 'ES', fetch(context) }
```

```js
const { createPlenergyCollector } = require('@gasolinaradar/plenergy-collector');

const plenergyCollector = createPlenergyCollector({
  logger,
});

const stations = await plenergyCollector.fetch({
  reportProgress(percent, metadata = {}) {
    console.log(`${percent}%`, metadata);
  },
});
```

---

## Options / Opciones

| Option             | Type                     | Default | Description                                                                |
| ------------------ | ------------------------ | ------- | -------------------------------------------------------------------------- |
| `url`              | `string \| () => string` | Plenergy URL | Dataset URL. As a function, it is evaluated on every fetch. Defaults to the official `json.php` endpoint. |
| `scrapeConcurrency` | `number \| () => number` | `4`     | Maximum number of simultaneous station page scrapes.                       |
| `timeout`          | `number`                 | `15000` | HTTP timeout in milliseconds.                                              |
| `retries`          | `number`                 | `3`     | Retry attempts for the dataset request before failing.                     |
| `logger`           | `{ info, warn, debug }`  | `console` | Injectable logger.                                                      |
| `httpClient`       | `{ get(url, opts) }`     | `axios` | Injectable HTTP client (useful for tests or custom TLS settings).          |

| Opción             | Tipo                      | Por defecto | Descripción                                                                 |
| ------------------ | ------------------------- | ----------- | --------------------------------------------------------------------------- |
| `url`              | `string \| () => string`  | URL Plenergy | URL del dataset. Como función, se evalúa en cada fetch. Por defecto el endpoint oficial `json.php`. |
| `scrapeConcurrency` | `number \| () => number` | `4`         | Número máximo de scraping simultáneo de páginas de estación.                |
| `timeout`          | `number`                  | `15000`     | Timeout HTTP en milisegundos.                                               |
| `retries`          | `number`                  | `3`         | Intentos de reintento del dataset antes de fallar.                          |
| `logger`           | `{ info, warn, debug }`   | `console`   | Logger inyectable.                                                          |
| `httpClient`       | `{ get(url, opts) }`      | `axios`     | Cliente HTTP inyectable (útil en tests o para configuración TLS personalizada). |

> **Note:** When `httpClient` is injected, the collector does not build any HTTP client itself. Pass an axios instance with your own TLS settings (e.g. `rejectUnauthorized`) if you need custom certificate validation.

> **Nota:** Cuando se inyecta `httpClient`, el collector no construye ningún cliente HTTP propio. Pasa una instancia de axios con tu propia configuración TLS (p. ej. `rejectUnauthorized`) si necesitas validación de certificados personalizada.

---

## Output schema / Esquema de salida

Each normalized station looks like this / Cada estación normalizada tiene esta forma:

```js
{
  source: 'plenergy',
  country: 'ES',
  sourceStationId: '1000',
  name: 'Estación A',
  address: 'Calle Mayor 1',
  municipality: 'Madrid',
  province: 'Madrid',
  postalCode: '28013',
  schedule: '24h',
  services: ['fuel_pumps', 'ev_chargers'],
  location: {
    type: 'Point',
    coordinates: [-3.7038, 40.4168], // [longitude, latitude]
  },
  prices: {
    gasolina95: 1.759,
    gasoleoa: 1.489,
  },
  lastUpdated: Date,
}
```

Notes / Notas:

- Prices are keyed by slug (`Gasolina 95` → `gasolina95`) and are `number | null`. When neither the list nor the station page provides prices, `prices` is `undefined`.
- Coordinates are `[longitude, latitude]` (GeoJSON order). Stations that cannot be resolved with coordinates are skipped (logged as warnings).
- Stations whose page cannot be scraped keep whatever prices the list payload provided (none if it provided none).

---

## Progress reporting / Reporte de progreso

The collector accepts an optional `context.reportProgress(percent, metadata)` callback:

```js
const stations = await plenergyCollector.fetch({
  reportProgress(percent, metadata) {
    // percent: 5  -> requesting the dataset
    // percent: 10 -> dataset fetched, processing stations
    // percent: 10-100 -> processing/scraping each station
    // percent: 100 -> completed
    console.log(percent, metadata.stage);
  },
});
```

---

## Data source / Fuente de datos

**EN:** The data is the public station dataset of **Plenergy** (Spain), published at:

**ES:** Los datos provienen del dataset público de estaciones de **Plenergy** (España), publicado en:

- `https://plenergy.es/estaciones_datos/json.php`

This project is **not affiliated with** Plenergy. The data belongs to Plenergy and is provided "as is". See the legal documents below.

Este proyecto **no está afiliado** a Plenergy. Los datos pertenecen a Plenergy y se proporcionan "tal cual". Consulta los documentos legales a continuación.

---

## Legal / Legal

**EN:**

- [LEGAL.md](./LEGAL.md) — Legal notice and disclaimer (bilingual).
- [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) — Data attribution and third-party licenses.
- [LICENSE](./LICENSE) — MIT License (applies to this software, **not** to the underlying Plenergy data).

**ES:**

- [LEGAL.md](./LEGAL.md) — Aviso legal y descargo de responsabilidad (bilingüe).
- [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) — Atribución de datos y licencias de terceros.
- [LICENSE](./LICENSE) — Licencia MIT (aplica a este software, **no** a los datos subyacentes de Plenergy).

---

## Tests

```bash
npm test
```

---

## License / Licencia

**EN:** MIT. See [LICENSE](./LICENSE). The Plenergy data is **not** covered by this license.

**ES:** MIT. Consulta [LICENSE](./LICENSE). Los datos de Plenergy **no** están cubiertos por esta licencia.
