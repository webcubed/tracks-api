# tracks-api

A REST API for New York City transit: subway, Long Island Rail Road (LIRR), and MTA buses. The API is rooted at `/v1`.

Static schedules, routes, stops, and geometry come from GTFS. Live arrivals, vehicles, and service alerts come from MTA realtime feeds. No API key is required by clients.

## Quick start

```sh
curl https://your-api.example/v1/agencies
curl 'https://your-api.example/v1/arrivals?stop=127'
curl 'https://your-api.example/v1/stops?lat=40.75&lon=-73.99&radius=400'
```

All successful responses use `{ "data": ... }`; failures use `{ "error": { "code", "message" } }`.

## API guides

- [Agencies](/agencies) — available feeds and agency IDs.
- [Routes](/routes) — route listings and GeoJSON shapes.
- [Stops and schedules](/stops) — stop lookup, proximity search, and departures.
- [Arrivals](/arrivals) — realtime arrivals by stop.
- [Vehicles](/vehicles) — realtime vehicle locations by route.
- [Alerts](/alerts) — active service alerts.
- [Fares](/fares) — fare reference by agency.
- [Journey planning](/journey) — static timetable itinerary planning.
- [Errors](/errors) — error envelope and codes.

## Response notes

- Longitude is named `lon`; GeoJSON coordinates use standard `[lon, lat]` order.
- Stop wheelchair accessibility is omitted if the source feed has no information.
- Realtime data is cached briefly; scheduled times come from static GTFS data.
