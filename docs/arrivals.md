# Arrivals

`GET /v1/arrivals` returns live arrivals at a stop from GTFS-Realtime trip updates.

## Query parameters

| Parameter | Required | Description |
| --- | --- | --- |
| `stop` | Yes | Stop ID. |
| `route` | No | Limit arrivals to a route. |
| `agency` | No | Pin the feed when a stop ID appears in more than one feed. |

The response contains the resolved stop and an `arrivals` list. Arrival entries include route, direction, headsign, arrival time, minutes away, realtime status, and delay; occupancy and vehicle ID are included when available. Subway directions use `uptown`/`downtown`; other services use cardinal directions.

## Examples

```sh
curl 'https://your-api.example/v1/arrivals?stop=127'
curl 'https://your-api.example/v1/arrivals?stop=127&route=1&agency=subway'
curl 'https://your-api.example/v1/arrivals?stop=237&agency=lirr'
```

`stop` is required (`400 MISSING_STOP`). An unknown stop returns `404 STOP_NOT_FOUND`. An unavailable realtime feed returns `502 FEED_UNAVAILABLE`.
