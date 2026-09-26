# tracks-api — agent guide

REST API for NYC transit (subway, LIRR, bus). TypeScript + Hono + DuckDB (in-memory, reads remote Parquet over `httpfs`) + protobufjs.

## Read these first

| Doc                                           | Path                                                    |
| --------------------------------------------- | ------------------------------------------------------- |
| API spec (authoritative for response shapes)  | `~/Documents/Obsidian Vault/tracks-api-design.md`       |
| Data sources / proto reference                | `~/Documents/Obsidian Vault/tracks-api-data-sources.md` |
| MTA project notes (feeds, protos, app design) | `~/Documents/Obsidian Vault/progaming/MTA project/`     |

The two `tracks-api-*.md` files **are** the spec. Match response shapes, query params, enum values and error codes exactly. Where the spec shows example JSON, prefer it over whatever the raw GTFS table gives you.

The MTA project folder (`~/Documents/Obsidian Vault/progaming/MTA project/`) is assorted reference notes — most of it useful, not fallback data:

- `gtfs tutorial.md` — the map of the data landscape: official static GTFS zips (regular + `gtfs_supplemented.zip` for the next 7 days of service changes), realtime feed URLs, protobuf sources, links to MTA structure docs. No API key needed for realtime.
- `Outline.md`, `what i need.md`, `working.md` — app-side design notes (proximity notifications, per-mode pages), context only.

Fallback (non-GTFS) APIs — only these three docs are fallback data sources:

- `mta radar production api.md` — LIRR `/locations`, `/countdown/{station}`, `/status`, Solari board, health. Has track assignment, per-section delay, actual vs scheduled track. Use only when GTFS/GTFS-RT can't answer.
- `mta.info production api.md` — OTP `nearby` endpoint (walk distance + arrivals around a point).
- `MTA Bustime Api documentation.md` — SIRI/OBA stop monitoring.

These fallbacks are undocumented, unstable production APIs. GTFS first, fallback second.

## Commands

```sh
pnpm dev                 # tsx watch, needs .env (missing is fine — nothing reads it)
pnpm exec tsx src/index.ts   # no watch; server on :3000
pnpm lint                # xo (see "Lint" below)
pnpm exec tsc --noEmit   # typecheck — run with lint, always
pnpm exec prettier --write <files>

# ad-hoc data exploration (throwaway-ish but lint-clean, keep them working):
pnpm exec tsx scripts/schema.ts                                   # per-feed column matrix
pnpm exec tsx scripts/sql.ts <agency> <table> "<sql with {{url}}>" # query one parquet file
pnpm exec tsx scripts/rt.ts <url> [entities] [nyct|mercury]       # decode a GTFS-RT feed
```

No test framework. **Testing means: boot the server, curl every route you touched, check status + shape.** Do it the moment a feature lands, before committing.

```sh
pnpm exec tsx src/index.ts & sleep 6
curl -s localhost:3000/v1/routes?agency=subway | head -c 400
```

Server startup awaits `loadTable(id, "agency")` and `getRoutes(id)` for all 8 feeds — first boot downloads every static table plus geometry, ~13s. `stop_times` is deliberately **not** preloaded (millions of rows); query it per request.

## Layout

```
src/
├── index.ts              # Hono + serve; warms agency/routes before listening
├── db.ts                 # memoized DuckDB connection (promise-memoized, not boolean)
├── constants.ts          # REALTIME_FEEDS, AGENCIES (as const), getStaticFeedUrl
├── lib/
│   ├── parquet.ts        # queryTable(agency, table, where?) + runQuery(sql) — uncached IO
│   └── loadTable.ts      # loadTable(agency, table) — promise-memoized, one feed
├── services/             # one file per endpoint group; type + toApi + id index
├── v1/index.ts           # mounts route groups
├── v1/routes/            # Hono routers, one per spec section
└── types/
    ├── api.ts            # ApiResponse<T>, ApiErrorResponse<T>
    ├── static.ts         # GTFS row types + TableMap
    └── realtime.ts       # GTFS-RT decoded payload + Mercury alert types
```

### Data-access rules (don't regress these)

- **Every parquet column is VARCHAR** — `scripts/convert.ts` reads CSV with `all_varchar=true`. `CAST(... AS DOUBLE/INTEGER)` in SQL for ordering and arithmetic; `Number(...)` in TS for numeric API fields. `type` checks are the only reliable NULL test (DuckDB returns `null` from `getRowObjectsJS`).
- `queryTable` = raw uncached read of one parquet file. Never memoize inside it (it takes arbitrary `WHERE`).
- `loadTable(agency, table)` = every row of one table from **one feed**, memoized **by promise** so concurrent callers share one load. Failed loads evict themselves. Keyed on feed + table because `Routes.agency_id`/`Stops.agency_id` are the GTFS operator, shared by all six bus feeds — flattening feeds loses their origin.
- Small tables (`agency`, `routes`, `stops`) → `loadTable` + in-memory `Map` index. Big tables (`stop_times`, `trips`, `shapes`) → `queryTable`/`runQuery` with `WHERE` per request.
- `memoize(fn)` (`src/lib/memoize.ts`) is the shared promise-memoization helper for services. Use it for any per-key lazy index.
- Promise-memoize any lazy singleton (`db.ts`, `loadTable`). A `let loaded = false` guard does **not** dedupe in-flight work — that bug shipped once already.
- Agency IDs in URLs are **feed keys** (`subway`, `lirr`, `bus_bx`, `bus_b`, `bus_busco`, `bus_m`, `bus_si`, `bus_q`), never GTFS `agency_id` (`MTA NYCT`, `LI`). `AgencyId` ← `AGENCY_IDS`; `AgencyTableMap` is mapped from `AgencyId`.
- `routes.txt` lists all 307 MTA bus routes in every borough feed, but each feed's `trips` only covers its own subset (Brooklyn: 68). Filter routes through `trips`, or `GET /v1/routes?agency=bus_m` returns Brooklyn routes too.
- **Feed schemas differ** — subway `stops` has no `wheelchair_boarding`, LIRR `routes` has no `route_short_name`, LIRR and `bus_busco` have no `location_type`/`parent_station`. Run `pnpm exec tsx scripts/schema.ts` for the per-feed column matrix before assuming a column exists.
- **Subway real-time trip ids don't exist in static `trips`** — GTFS-RT publishes `{legacyTime}_{shape}` (`072350_1..S`) while static is `ASP26GEN-…_000600_1..S03R`; LIRR and bus ids do join. `getArrivals` fills subway `headsign` by matching route + direction + time (±4 min) against `getSchedule`, and takes `direction` from the platform suffix (`127N` → northbound → `uptown`).
- Stops are listed **without a `parent_station`** (subway: 496 stations, not 1488 platforms). `stop_times` only reference platforms, so a station's `routes` are the union of its children's.
- `wheelchairAccessible` is populated from `wheelchair_boarding` (LIRR only) — `1`→`true`, `2`→`false`, `0`/absent→**omitted**, never `false`. The spec's subway example shows `true`, but no subway/bus feed carries the field.
- 977 stop ids repeat across feeds (subway vs LIRR numeric ids). `GET /v1/stops/:id` has no `agency` param, so feeds are searched in `AGENCY_IDS` order — subway wins.
- Schedule: service days = `calendar` weekday row ∪ `calendar_dates` `exception_type='1'`, minus `exception_type='2'`. LIRR ships no `calendar` — `CALENDAR_FREE_FEEDS` is derived from `AgencyTableMap`, so naming a table the feed lacks fails at compile time. `direction` comes from the trip shape's first/last point; `trips.direction_id` means nothing portable across feeds.

## Lint (xo 2.0.2) — write to these, don't fix up after

`pnpm lint` and `pnpm exec tsc --noEmit` must both be clean before every commit.

Rules that have bitten us:

- `@typescript-eslint/array-type` — `ApiAgency[]` for simple types, `Array<Foo[bar]>` only for complex/conditional.
- `unicorn/no-await-expression-member` — no `(await f()).values()`; bind to a local first.
- `no-return-assign` — no `return (index ??= …)`; assign, blank line, return.
- `@typescript-eslint/promise-function-async` — a function returning a promise must be `async`, including `(a) => queryTable(…)` map callbacks.
- `@typescript-eslint/no-unsafe-type-assertion` — needs `// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion` (same style as `lib/parquet.ts`).
- `@stylistic/padding-line-between-statements` — blank line before `return` after a block.
- `@typescript-eslint/naming-convention` — variables must be camelCase / PascalCase / UPPER_CASE.
- Tabs, semicolons, Prettier (`prettier.config.mjs`, import sorting).

`xo.config.mjs` globally ignores `**/*.json`: xo 2.0.2 + eslint 10 crash loading compat-shimmed rules on JSON source.

## Verified data sources (2026-09-26)

Working:

- Subway GTFS-RT (8 line-cluster feeds), LIRR `lirr%2Fgtfs-lirr`, MNR `mnr%2Fgtfs-mnr` — no key.
- Alerts: `camsys%2Fall-alerts`, `camsys%2Fsubway-alerts`, `camsys%2Fbus-alerts`, `camsys%2Flirr-alerts`, `camsys%2Fmnr-alerts` — no key.
- Bus Time: `https://gtfsrt.prod.obanyc.com/{tripUpdates,vehiclePositions,alerts}?key=OBANYC` — key `OBANYC` works.
- Static parquet: `https://github.com/webcubed/tracks-api/releases/download/latest-gtfs/{agency}_{table}.parquet`.

Dead (404 / `NoSuchKey`) despite what the data-sources doc says — do not use:

- `mgt/alerts`, `mgt/alerts.json`, `mgt/gtfs-*` (Mercury endpoints)
- `lirr/gtfs` (use `lirr/gtfs-lirr`)

## Status / order of work

Static:

- [x] `GET /v1/agencies`, `GET /v1/agencies/:id`
- [x] `GET /v1/routes?agency=`, `GET /v1/routes/:id?agency=` (with `shape` GeoJSON from `shapes`)
- [x] `GET /v1/stops?agency=&route=`, `GET /v1/stops/:id`
- [x] `GET /v1/stops/:id/schedule?date=`

Realtime:

- [x] `GET /v1/arrivals?stop=&route=` (GTFS-RT trip updates, subway/LIRR/bus)
- [x] `GET /v1/vehicles?route=&agency=`
- [x] `GET /v1/alerts?agency=&route=`

## Git

Commit after every working feature. **Never push.** Messages: lowercase, imperative, one line.
