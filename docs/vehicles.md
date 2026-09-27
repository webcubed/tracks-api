# Vehicles

`GET /v1/vehicles` returns realtime vehicle positions for a route.

## Query parameters

| Parameter | Required | Description |
| --- | --- | --- |
| `route` | Yes | Route ID. |
| `agency` | No | Pin the feed when route IDs collide. |

Vehicle objects include an ID and route. Location and GeoJSON point geometry are included when available, along with optional bearing, speed, next stop, and occupancy.

## Examples

```sh
curl 'https://your-api.example/v1/vehicles?route=1&agency=subway'
curl 'https://your-api.example/v1/vehicles?route=B'
```

`route` is required (`400 MISSING_ROUTE`). An unknown route returns `404 ROUTE_NOT_FOUND`; an unavailable realtime feed returns `502 FEED_UNAVAILABLE`.
