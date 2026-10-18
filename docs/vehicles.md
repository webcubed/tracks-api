# Vehicles

`GET /v1/vehicles` returns realtime vehicle positions for a route. The map uses `GET /v1/vehicles/feed` instead: one request per visible feed, optionally narrowed to routes and a geographic viewport, rather than one request per route.

## Query parameters

| Parameter | Required | Description                          |
| --------- | -------- | ------------------------------------ |
| `route`   | Yes      | Route ID.                            |
| `agency`  | No       | Pin the feed when route IDs collide. |

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

## Train run

`GET /v1/vehicles/:id/route` describes what a live train actually does: every station, yard, junction and interlocking its run touches, in order, with the track it uses at each. It comes from the MTA's LIRR tracking system, which is the only place those operational locations are named, so it applies to the LIRR feed alone; `route` is required for the same reason the vehicle listing needs it — vehicle ids are unique only inside a route.

The train is looked up by its number, which the live feed carries as part of the vehicle id, and the run is read from the station the train is next approaching. Names come from the feed's own stations; a location that is not a station (a yard or interlocking, such as `WSY` or `HAR`) is returned under its railroad code, because the static feed does not contain it. `events[].passed` marks the points already behind the train, and `error` is set when the run cannot be resolved — most often because the feed has not reported a next stop yet.

```sh
curl 'https://your-api.example/v1/vehicles/GO202_26_6178_V/route?agency=lirr&route=1'
```

```json
{
	"data": {
		"vehicle": { "id": "GO202_26_6178_V", "route": "1" },
		"train": "6178",
		"branch": "Babylon",
		"headsign": "Babylon",
		"direction": "E",
		"station": { "code": "LHT", "name": "Lindenhurst" },
		"source": "mta-radar-countdown",
		"events": [
			{
				"code": "WSY",
				"name": "WSY",
				"stopType": "EQUIPMENT",
				"track": "09",
				"time": 1790547300,
				"passed": true
			},
			{
				"code": "NYK",
				"name": "Penn Station",
				"stopType": "STOP",
				"track": "16",
				"time": 1790548260,
				"passed": true
			}
		]
	}
}
```

### Batched visible vehicles

`GET /v1/vehicles/feed?agency=bus_bx&routes=BX1,BX2&west=-74.1&south=40.5&east=-73.6&north=40.9` returns all vehicles for the listed routes inside the bounds. `routes` and all four bounds are optional; the frontend sends the visible route subset and padded map bounds. Bounds must be supplied together and use west/south/east/north coordinates. One feed response is shared across all requested routes, so this endpoint is the efficient choice for a live map.

## Examples

```sh
curl 'https://your-api.example/v1/vehicles?route=1&agency=subway'
curl 'https://your-api.example/v1/vehicles?route=B'
curl 'https://your-api.example/v1/vehicles/feed?agency=bus_bx&routes=BX1,BX2&west=-74.1&south=40.5&east=-73.6&north=40.9'
```

`route` is required (`400 MISSING_ROUTE`). An unknown route returns `404 ROUTE_NOT_FOUND`; an unavailable realtime feed returns `502 FEED_UNAVAILABLE`.
