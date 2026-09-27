# Stops and schedules

Find stops by feed, route, or geographic proximity, retrieve a stop, or query its scheduled departures.

## Endpoints

| Method and path | Query parameters | Description |
| --- | --- | --- |
| `GET /v1/stops` | optional `agency`, `route`; optional `lat`, `lon`, `radius` together | List stops, filter to a route, or search nearby. |
| `GET /v1/stops/:id` | optional `agency` | Retrieve stop detail. |
| `GET /v1/stops/:id/schedule` | optional `agency`, `date` | List scheduled departures. |

### Stop list and proximity

Provide `agency` to restrict the results to one [feed](/agencies). The `route` filter lists stops served by that route.

For a proximity search, pass all three location parameters:

- `lat`: latitude in decimal degrees.
- `lon`: longitude in decimal degrees.
- `radius`: search distance in metres; must be positive.

Nearby results include `distance` in metres and are ordered nearest first. Supplying only some of these parameters returns `400 INVALID_LOCATION`.

```sh
curl 'https://your-api.example/v1/stops?agency=subway&route=1'
curl 'https://your-api.example/v1/stops?lat=40.75&lon=-73.99&radius=400'
```

### Stop detail

Without an `agency`, feeds are searched in a fixed order. Stop IDs can collide, so use `agency` to pin the feed when necessary. For example, LIRR Penn Station uses ID `237`, which is also used by a subway stop.

```sh
curl 'https://your-api.example/v1/stops/237?agency=lirr'
```

### Schedule

`date` is optional and uses `YYYY-MM-DD`; it defaults to today. The schedule applies service-day exceptions. Use `agency` to resolve colliding stop IDs.

```sh
curl 'https://your-api.example/v1/stops/127/schedule?date=2026-09-26'
curl 'https://your-api.example/v1/stops/237/schedule?agency=lirr'
```

Successful responses use `{ "data": ... }`. Invalid dates return `400 INVALID_DATE`; unknown stops return `404 STOP_NOT_FOUND`.
