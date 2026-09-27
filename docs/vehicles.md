# Vehicles

`GET /v1/vehicles` returns realtime vehicle positions for a route.

## Query parameters

| Parameter | Required | Description |
| --- | --- | --- |
| `route` | Yes | Route ID. |
| `agency` | No | Pin the feed when route IDs collide. |

Vehicle objects include an ID and route. Location and GeoJSON point geometry are included when available, along with optional bearing, speed, next stop, next stop ID, and occupancy.

## Response shape

`data` is an array. Location, geometry, and the other live position fields are omitted when unavailable.

```json
{
  "data": [
    {
      "id": "sample-vehicle-id",
      "route": "1",
      "location": { "lat": 40.75529, "lon": -73.987495 },
      "geometry": { "type": "Point", "coordinates": [-73.987495, 40.75529] },
      "bearing": 180,
      "speed": 8.2,
      "nextStop": "34 St-Penn Station",
      "nextStopId": "A12",
      "occupancy": "FEW_SEATS_AVAILABLE"
    }
  ]
}
```

The sample illustrates the shape; actual values depend on the realtime feed.

## Examples

```sh
curl 'https://your-api.example/v1/vehicles?route=1&agency=subway'
curl 'https://your-api.example/v1/vehicles?route=B'
```

`route` is required (`400 MISSING_ROUTE`). An unknown route returns `404 ROUTE_NOT_FOUND`; an unavailable realtime feed returns `502 FEED_UNAVAILABLE`.
