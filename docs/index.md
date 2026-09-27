# tracks-api

A REST API for New York City transit: subway, Long Island Rail Road (LIRR), and MTA buses. Browse this reference at `/docs/`; the API is rooted at `/v1`.

Static schedules, routes, stops, and geometry come from GTFS. Live arrivals, vehicles, and service alerts come from MTA realtime feeds. No API key is required by clients.

## Quick start

```sh
curl https://your-api.example/v1/agencies
curl 'https://your-api.example/v1/arrivals?stop=127'
curl 'https://your-api.example/v1/stops?lat=40.75&lon=-73.99&radius=400'
```

All successful responses use `{ "data": ... }`; failures use `{ "error": { "code", "message" } }`.

## Agencies {#agencies}

| Method and path | Description |
| --- | --- |
| `GET /v1/agencies` | List the eight feed agencies. |
| `GET /v1/agencies/:id` | Get one agency by feed key. |

Agency IDs are feed keys, not raw GTFS operator IDs: `subway`, `lirr`, `bus_bx`, `bus_b`, `bus_busco`, `bus_m`, `bus_si`, and `bus_q`.

```sh
curl https://your-api.example/v1/agencies/subway
```

## Routes {#routes}

| Method and path | Query parameters | Description |
| --- | --- | --- |
| `GET /v1/routes` | required `agency` | List routes operated in a feed, with colors and a GeoJSON `shape` when available. |
| `GET /v1/routes/:id` | required `agency` | Get one route in a feed. |

```sh
curl 'https://your-api.example/v1/routes?agency=subway'
curl 'https://your-api.example/v1/routes/A?agency=subway'
```

## Stops and schedules {#stops}

| Method and path | Query parameters | Description |
| --- | --- | --- |
| `GET /v1/stops` | optional `agency`, `route`; optional location triplet `lat`, `lon`, `radius` | List stops, filter by route, or find nearby stops. `radius` is metres; nearby results include `distance` and are sorted closest first. |
| `GET /v1/stops/:id` | optional `agency` | Get a stop. If `agency` is omitted, feeds are searched in a fixed order. |
| `GET /v1/stops/:id/schedule` | optional `agency`, `date` (`YYYY-MM-DD`; defaults to today) | List scheduled departures for a service date. |

`lat`, `lon`, and `radius` must be supplied together. Use `agency=lirr` to disambiguate LIRR Penn Station (`237`) from the subway stop with the same ID.

```sh
curl 'https://your-api.example/v1/stops?agency=subway&route=1'
curl 'https://your-api.example/v1/stops?lat=40.75&lon=-73.99&radius=400'
curl 'https://your-api.example/v1/stops/237?agency=lirr'
curl 'https://your-api.example/v1/stops/127/schedule?date=2026-09-26'
```

## Arrivals {#arrivals}

`GET /v1/arrivals` returns realtime arrivals at a stop.

| Query parameter | Required | Description |
| --- | --- | --- |
| `stop` | Yes | Stop ID. |
| `route` | No | Filter to a route. |
| `agency` | No | Pin the feed when stop IDs collide. |

Arrival results include route, direction, headsign, arrival time, minutes away, realtime status, delay, and optional occupancy and vehicle ID.

```sh
curl 'https://your-api.example/v1/arrivals?stop=127'
curl 'https://your-api.example/v1/arrivals?stop=237&agency=lirr'
```

## Vehicles {#vehicles}

`GET /v1/vehicles` lists live positions for a route.

| Query parameter | Required | Description |
| --- | --- | --- |
| `route` | Yes | Route ID. |
| `agency` | No | Pin the feed when route IDs collide. |

Vehicle fields can include location (latitude/longitude), GeoJSON point geometry, bearing, speed, next stop, and occupancy.

```sh
curl 'https://your-api.example/v1/vehicles?route=1&agency=subway'
```

## Alerts {#alerts}

`GET /v1/alerts` lists active MTA service alerts.

| Query parameter | Required | Description |
| --- | --- | --- |
| `agency` | No | Filter by feed key. |
| `route` | No | Filter to alerts naming this route. |

```sh
curl 'https://your-api.example/v1/alerts?agency=subway&route=1'
```

## Fares {#fares}

`GET /v1/fares` returns the curated fare reference for all feeds, or a single feed when filtered.

| Query parameter | Required | Description |
| --- | --- | --- |
| `agency` | No | Filter by feed key. |

Fare values are maintained from MTA fare information and may change; confirm current prices with MTA before travel.

```sh
curl 'https://your-api.example/v1/fares?agency=lirr'
```

## Journey planning {#journey-planning}

`GET /v1/journey` finds up to five earliest-arrival itineraries on the static timetable. Rail legs use subway and LIRR; bus stops may be walk connections, but a bus ride is not planned as a leg.

| Query parameter | Required | Description |
| --- | --- | --- |
| `from` | Yes | Origin stop ID. |
| `to` | Yes | Destination stop ID. |
| `date` | No | Service date (`YYYY-MM-DD`); defaults to today. |
| `time` | No | New York local time (`HH:MM:SS`); defaults to now. |
| `fromAgency` | No | Pin the origin feed to disambiguate a stop ID. |
| `toAgency` | No | Pin the destination feed to disambiguate a stop ID. |

Itineraries include departure and arrival times, duration, and ride legs. Walking connections between nearby feeds/stations are implicit.

```sh
curl 'https://your-api.example/v1/journey?from=127&to=102'
curl 'https://your-api.example/v1/journey?from=237&to=102&fromAgency=lirr&toAgency=subway&date=2026-09-26&time=08:30:00'
```

## Errors {#errors}

Errors follow `{ "error": { "code": "...", "message": "..." } }`.

| HTTP status | Error codes | Meaning |
| --- | --- | --- |
| `400` | `MISSING_STOP`, `MISSING_ROUTE`, `MISSING_FROM`, `MISSING_TO`, `INVALID_DATE`, `INVALID_TIME`, `INVALID_LOCATION` | Missing or invalid query parameters. |
| `404` | `AGENCY_NOT_FOUND`, `ROUTE_NOT_FOUND`, `STOP_NOT_FOUND` | Requested agency, route, or stop was not found. |
| `502` | `FEED_UNAVAILABLE` | An upstream realtime feed is unavailable. |
| `500` | `INTERNAL_ERROR` | Unexpected server error. |

## Response notes

- Every success and error body is JSON. Successful API endpoints use the `{ "data": ... }` envelope.
- Longitude is named `lon`; GeoJSON coordinates use standard `[lon, lat]` order.
- Stop wheelchair accessibility is omitted if the source feed has no information.
- Realtime data is cached briefly; scheduled times come from static GTFS data.
