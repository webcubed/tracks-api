# Experimental API

Routes under `/experimental` proxy production MTA APIs that expose information not currently represented by the stable GTFS/GTFS-Realtime endpoints. These are explicitly experimental: the upstream APIs are undocumented/unstable, and response payloads are passed through without a stable schema guarantee. The server adds `source` and `experimental: true` beside upstream `data`.

## MTA OTP Nearby

### `GET /experimental/mta-info/nearby`

Returns nearby transit stops with walking distance/time and walking path geometry, plus alerts scoped to each stop. With the `stops` parameter it can request stop IDs across MTA subway, bus, and LIRR (the notes also mention NJT, PATH, and Metro-North); this service's current agency coverage may vary.

The stable `/v1/stops?lat=&lon=&radius=` route already returns straight-line proximity and stop data. This endpoint adds OTP pedestrian routing and stop-specific alerts; the top-level stop alerts and cross-mode results can also differ from the stable `/v1/alerts` endpoint.

The copied reference contains credentials, but they have been redacted from `references/mta-project/` and are never hardcoded. If `MTA_NEARBY_API_KEY` is set in the server environment, it is forwarded upstream; otherwise the request is attempted without a key. A live request without a key succeeded during integration testing. Upstream errors are returned as `502 EXPERIMENTAL_FEED_UNAVAILABLE`.

Parameters:

| Name                   | Required                                 | Description                                                                                                              |
| ---------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `lat`, `lon`, `radius` | Required unless `stops` is supplied      | Center and positive radius in metres.                                                                                    |
| `stops`                | Required unless coordinates are supplied | Upstream stop references, e.g. `MTASUBWY:127` or `LI:3`; can be repeated or comma-separated as accepted by the upstream. |
| `mode`                 | No                                       | `SUBWAY`, `RAIL`, or `BUS`; defaults to an empty mode accepted by the documented endpoint.                               |
| `timeRange`            | No                                       | Forwarded to upstream; reference calls its units uncertain.                                                              |

```sh
curl 'https://your-api.example/experimental/mta-info/nearby?lat=40.75&lon=-73.99&radius=400'
curl 'https://your-api.example/experimental/mta-info/nearby?stops=MTASUBWY%3A127&mode=SUBWAY'
```

Response outline (fields are upstream-defined):

```json
{
	"data": [
		{
			"stop": {
				"id": "MTA:401360",
				"name": "7 AV/W 34 ST",
				"lat": 40.750553,
				"lon": -73.991071,
				"dist": 129,
				"walkTime": 114,
				"geometry": { "points": "encoded-polyline", "length": 11 }
			},
			"alerts": [],
			"groups": []
		}
	],
	"source": "mta-otp-nearby",
	"experimental": true
}
```

`dist`, `walkTime`, and `geometry` are present for coordinate-based searches and omitted for direct `stops` lookup, according to the copied reference. Treat that behavior as provisional.

## MTA Radar / unified railroad API

These routes proxy `backend-unified.mylirr.org`. In addition to standard arrival and vehicle information, the documented LIRR payloads provide posted/actual track assignments and track changes, dispatch hold/cancel/OTP status, richer train location and telemetry, train consists and per-car loading/passenger estimates, detailed operating events, and Solari board connection suggestions. `/status` includes LIRR and Metro-North branch alerts; `/health` reports upstream subsystem health/freshness.

### `GET /experimental/mta-radar/locations`

Optional `railroad` (defaults to `LIRR`) and `geometry` (defaults to `TRACK_TURF`) are sent upstream. Radar requests include the required `Accept-Version: 3.0` header. The response is an upstream train array. Each train may include `details`, `consist`, `location`, `status`, and alerts. Location/status/consist fields include GPS coordinates and source, speed/heading, `otp`, held/canceled state, fleet and car counts/loading. Per-stop data may contain `sign_track`, `posted`, and `track_change`.

The upstream requires the `Accept-Version: 3.0` request header. The proxy supplies it for Radar calls; without it, the upstream may respond with HTTP `301`. The locations endpoint has returned train data when called with the required header, but the upstream remains undocumented and can change.

```sh
curl 'https://your-api.example/experimental/mta-radar/locations'
```

### `GET /experimental/mta-radar/countdown/:station`

`:station` is a three-character station code such as `JAM` or `NYK`. Required query parameters: `include_passed=true|false` and positive `hours` (fractional values such as `1.0` are accepted). The proxy sends the upstream-required `Accept-Version: 3.0` header. Returns trains relevant to the station, including `details.events` with scheduled/actual/operational event times and scheduled/actual tracks. Events can include operational waypoints that are not passenger stops.

The endpoint has returned train data through the proxy when called with this version header. Without it, upstream responds with HTTP `301`; with it, the endpoint returns HTTP `200`. The upstream remains undocumented and can change.

```sh
curl 'https://your-api.example/experimental/mta-radar/countdown/JAM?include_passed=false&hours=2'
```

### `GET /experimental/mta-radar/solari/:station`

Returns the passenger-facing departure board for a three-character station code. The upstream payload can include posted track, service status and official transfer connections that are not represented in the stable `/v1/arrivals` shape. The proxy sends the upstream-required `Accept-Version: 3.0` header.

The endpoint has returned departure-board data through the proxy when called with this version header. The upstream remains undocumented and can change.

```sh
curl 'https://your-api.example/experimental/mta-radar/solari/JAM'
```

### `GET /experimental/mta-radar/status`

Returns an object with global `banners` and a `status` array for LIRR and Metro-North branches, including branch-level operational status and detailed HTML alert text. This endpoint returned live data during integration testing.

```json
{
	"data": {
		"banners": [],
		"status": [
			{
				"branch": "Babylon",
				"branch_id": "BY",
				"railroad": "LIRR",
				"status": "Special Schedule",
				"status_level": 2,
				"alerts": []
			}
		]
	},
	"source": "mta-radar-status",
	"experimental": true
}
```

### `GET /experimental/mta-radar/health`

Returns dynamic upstream subsystem keys with `healthy` and `age` (seconds since the last reported update/heartbeat), e.g. train telemetry and car-loading subsystems. This endpoint returned live data during integration testing.

```json
{
	"data": {
		"wmdsM9": { "healthy": true, "age": 4 },
		"loadingM7": { "healthy": true, "age": 5 }
	},
	"source": "mta-radar-health",
	"experimental": true
}
```

### Errors

Invalid station IDs/options return `400`. Upstream failures or malformed JSON return `502 EXPERIMENTAL_FEED_UNAVAILABLE`. These APIs can change without notice; validate fields before relying on them in applications.
