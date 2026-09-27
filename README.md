# tracks-api

A REST API for New York City transit: subway, Long Island Rail Road, and MTA buses. Built with TypeScript, Hono, in-memory DuckDB, and protobufjs.

Static GTFS data (schedules, routes, stops, shapes) is served from Parquet files converted from the MTA's official feeds; live arrivals, vehicle positions, and service alerts come straight from the MTA's GTFS-Realtime and Mercury feeds. No API keys required.

## Endpoints

| Endpoint                                                      | What it gives you                                                                                                                                                                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/agencies` · `/v1/agencies/:id`                       | The eight feed keys (`subway`, `lirr`, and six borough bus feeds) with name, URL, timezone, and modes                                                                                                                                                   |
| `GET /v1/routes?agency=` · `/v1/routes/:id?agency=`           | Routes per feed, with official colors and a GeoJSON `shape` per route                                                                                                                                                                                   |
| `GET /v1/stops?agency=&route=`                                | Stops, optionally filtered to a route, with the routes serving each stop                                                                                                                                                                                |
| `GET /v1/stops?lat=&lon=&radius=`                             | Stops within a radius (metres), sorted by distance, with a `distance` field                                                                                                                                                                             |
| `GET /v1/stops/:id`                                           | One stop's detail; feeds are searched in a fixed order, subway first (`?agency=` pins one feed: LIRR's Penn Station is `237?agency=lirr`)                                                                                                               |
| `GET /v1/stops/:id/schedule?date=`                            | Scheduled departures for a date (defaults to today), service-day exceptions applied (`?agency=` as above)                                                                                                                                               |
| `GET /v1/arrivals?stop=&route=&agency=`                       | Live arrivals from GTFS-RT trip updates: delay-aware, with headsign, direction, occupancy, and vehicle id (`agency` pins the stop's feed)                                                                                                               |
| `GET /v1/vehicles?route=&agency=`                             | Live vehicle positions, bearing, speed, next stop                                                                                                                                                                                                       |
| `GET /v1/alerts?agency=&route=`                               | Service alerts with severity, effect, and active periods                                                                                                                                                                                                |
| `GET /v1/fares?agency=`                                       | Current fares per agency (base, reduced, express, CityTicket)                                                                                                                                                                                           |
| `GET /v1/journey?from=&to=&date=&time=&fromAgency=&toAgency=` | Earliest-arrival itineraries on the static timetable: up to three rides (subway + LIRR), station-level transfers via `transfers.txt`, and walk connections between nearby stations across feeds (`fromAgency`/`toAgency` pin the feed for shadowed ids) |

Experimental production-source proxies live under `/experimental` and are documented separately at [`/docs/experimental`](/docs/experimental). They include MTA OTP Nearby walking routes/stop alerts and MTA Radar railroad track, consist, operational, branch status, and health data. These undocumented upstreams are not part of the stable `/v1` contract; Radar locations/countdown/Solari returned redirects during initial checks. MTA Nearby optionally accepts `MTA_NEARBY_API_KEY` via environment configuration; no credential is checked into this repository.

Every `/v1` response uses the same envelope: `{"data": …}` on success, `{"error": {"code", "message"}}` on failure. Errors are `MISSING_*` (400) for absent required params, `INVALID_DATE` / `INVALID_TIME` / `INVALID_LOCATION` (400) for malformed ones, `*_NOT_FOUND` (404) for unknown ids, `FEED_UNAVAILABLE` (502) when an upstream is down, and `INTERNAL_ERROR` (500) for anything else.

## API documentation

A searchable VitePress API reference is served by the API at `/docs/` (and `/docs` redirects there). Build the static documentation before starting the server:

```sh
pnpm install
pnpm build                  # required for /docs/
pnpm dev                    # tsx watch; server on :3000
```

For a production start, use `pnpm build && pnpm start`. The server honors the platform-provided `PORT` environment variable (defaults to `3000`).

## Quickstart

```sh
pnpm install
pnpm dev                    # tsx watch; server on :3000
```

```sh
# Next 1/2/3 trains at Times Sq
curl -s localhost:3000/v1/arrivals?stop=127

# Stops within 400 metres of Penn Station
curl -s "localhost:3000/v1/stops?lat=40.75&lon=-73.99&radius=400"

# Times Sq to Jamaica: subway to Penn, walk, LIRR
curl -s "localhost:3000/v1/journey?from=127&to=102"

# Next trains at LIRR Penn Station (id 237 collides with a subway stop, so pin the feed)
curl -s "localhost:3000/v1/arrivals?stop=237&agency=lirr"
```

First boot downloads every static table plus shape geometry (~13 seconds); the tables are held in memory and refreshed hourly. `stop_times` (millions of rows) is queried per request against the remote Parquet files.

## Data sources

- **Static GTFS** ([MTA S3 zips](https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip)): converted to Parquet with `scripts/convert.ts` and published as release assets at `https://github.com/webcubed/tracks-api/releases/download/latest-gtfs/{agency}_{table}.parquet`. The server reads those over DuckDB's `httpfs`.
- **GTFS-Realtime**: eight subway line-cluster feeds plus LIRR and Metro-North, no key needed.
- **Service alerts**: the MTA's Mercury feeds, read from their JSON twins.
- **Bus Time**: `https://gtfsrt.prod.obanyc.com` (key `OBANYC`), one trip-updates and one vehicle-positions feed for all five boroughs.

## Architecture

```text
src/
├── index.ts              # Hono + serve; warms static tables, hourly refresh
├── constants.ts          # feed URLs, agency ids, table availability per feed
├── db.ts                 # promise-memoized DuckDB connection
├── lib/                  # parquet/SQL access, memoization, haversine, time
├── services/             # one file per endpoint group
├── v1/                   # routers per endpoint, shared error mapping
└── types/                # GTFS rows and decoded realtime payloads
```

A few decisions worth knowing before changing things:

- Every Parquet column is `VARCHAR` (the CSVs are read with `all_varchar`), so numeric fields are cast in SQL or converted with `Number(...)` in TypeScript.
- Small tables load into in-memory `Map` indexes; big tables are queried with `WHERE` per request. Memoization is by promise so concurrent callers share one load, and failed loads evict themselves.
- Subway real-time trip ids don't exist in the static `trips` table (different id schemes), so subway arrivals recover headsign and direction by matching against today's schedule and reading the platform suffix.
- The journey planner is a two-leg (direct + one transfer) earliest-arrival search; transfers match at station level, and cross-feed transfers are stations within 500 m of each other.

See [AGENTS.md](AGENTS.md) for the full data-access rules, per-feed quirks, and the current feature status. Copied MTA research notes live under [`references/mta-project/`](references/mta-project/); embedded credentials were redacted and the AI-generated upstream schemas remain unverified.

## Development

```sh
pnpm lint                   # xo, plus style rules
pnpm exec tsc --noEmit      # typecheck; run with lint, always
pnpm exec prettier --check .
```

There is no test framework. Testing means: boot the server, curl every route you touched, and check status and shape before committing. `pnpm exec tsx scripts/schema.ts` prints the per-feed column matrix, and `scripts/sql.ts` / `scripts/rt.ts` are ad-hoc tools for querying Parquet and decoding realtime feeds.

## AI disclosure

This codebase was largely written by an AI coding agent (OpenCode) working under human direction: the features, architecture, and documentation were shaped by the project owner, and every endpoint was verified against live MTA data before landing. It is a working project, not a demo, but it carries AI-typical gaps: read the known quirks in [AGENTS.md](AGENTS.md), run the checks above, and review before you build on it.
