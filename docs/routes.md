# Routes

List routes operating in a feed or retrieve one route by its ID. Routes include official colors and a GeoJSON `shape` when geometry is available. The route response's `type` field is a mode string such as `subway`, `rail`, or `bus` (not a numeric GTFS route-type code).

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

## Response shape

`GET /v1/routes` returns an array; `GET /v1/routes/:id` returns one route. A route without available shape geometry omits `shape`.

```json
{
  "data": [
    {
      "id": "1",
      "agency": "subway",
      "shortName": "1",
      "longName": "Broadway - 7 Avenue Local",
      "type": "subway",
      "color": "#EE352E",
      "textColor": "#FFFFFF",
      "shape": {
        "type": "LineString",
        "coordinates": [[-73.99, 40.75], [-73.98, 40.76]]
      }
    }
  ]
}
```

Coordinates are abbreviated for illustration. GeoJSON coordinates use `[lon, lat]` order.
