# Routes

List routes operating in a feed or retrieve one route by its ID. Routes include official colors and a GeoJSON `shape` when geometry is available.

## Endpoints

| Method and path | Query parameters | Description |
| --- | --- | --- |
| `GET /v1/routes` | required `agency` | List routes in a feed. |
| `GET /v1/routes/:id` | required `agency` | Retrieve a route in a feed. |

`agency` is one of the feed IDs listed on the [Agencies](/agencies) page. Bus feed results are limited to the routes actually served by that feed.

## Examples

```sh
curl 'https://your-api.example/v1/routes?agency=subway'
curl 'https://your-api.example/v1/routes/1?agency=subway'
```

Each success returns `{ "data": ... }`. An invalid agency returns `404` with `AGENCY_NOT_FOUND`; an unknown route returns `404` with `ROUTE_NOT_FOUND`.

A route shape, when present, follows GeoJSON LineString format with coordinates in `[lon, lat]` order.
