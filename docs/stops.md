# Stops and schedules

Find stops by feed, route, or geographic proximity, retrieve a stop, query its scheduled departures, or read a station departure board with live track assignments.

## Endpoints

| Method and path                | Query parameters                                                     | Description                                                      |
| ------------------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `GET /v1/stops`                | optional `agency`, `route`; optional `lat`, `lon`, `radius` together | List stops, filter to a route, or search nearby.                 |
| `GET /v1/stops/:id`            | optional `agency`                                                    | Retrieve stop detail.                                            |
| `GET /v1/stops/:id/schedule`   | optional `agency`, `date`                                            | List scheduled departures.                                       |
| `GET /v1/stops/:id/departures` | optional `agency`                                                    | List the current departure board, with posted track assignments. |

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

## Stop response shape

Stop lists return an array, while stop detail returns a single stop object. The proximity query adds `distance`; stops whose source feed has no accessibility value omit `wheelchairAccessible`.

```json
{
	"data": [
		{
			"id": "127",
			"name": "Times Sq-42 St",
			"location": { "lat": 40.75529, "lon": -73.987495 },
			"geometry": { "type": "Point", "coordinates": [-73.987495, 40.75529] },
			"agency": "subway",
			"routes": ["1", "2", "3", "7", "A", "C", "E", "N", "Q", "R", "W", "S"]
		}
	]
}
```

The example illustrates the shape; actual stop names, coordinates, and route lists come from GTFS.

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

## Schedule response shape

The schedule endpoint returns the stop plus its departures for the requested service date:

```json
{
	"data": {
		"stop": { "id": "127", "name": "Times Sq-42 St" },
		"departures": [
			{
				"route": "1",
				"headsign": "South Ferry",
				"departureTime": "08:31:00",
				"tripId": "sample-trip-id",
				"direction": "southbound"
			}
		]
	}
}
```

### Departures

The departure board is sourced from the MTA's LIRR tracking system, which is the only place track assignments are published, so it covers the LIRR feed alone: it is keyed by the three-letter station code that only that feed ships. Other feeds, and any LIRR stop without a code, return an empty board instead of an error.

```sh
curl 'https://your-api.example/v1/stops/237/departures?agency=lirr'
```

`track` is omitted until the tracking system posts an assignment, and `status.otp` is the schedule variance in seconds. If the tracking system cannot be reached the board is empty and carries an `error` string. Station codes in the response are expanded to feed station names.

```json
{
	"data": {
		"stop": { "id": "237", "name": "Penn Station" },
		"code": "NYK",
		"source": "mta-radar-solari",
		"departures": [
			{
				"train": "7755",
				"time": 1790550840,
				"track": "18",
				"direction": "E",
				"destination": "Port Washington",
				"stops": ["Woodside", "Mets-Willets Point", "Port Washington"],
				"status": { "otp": 0, "held": false, "canceled": false }
			}
		]
	}
}
```

Successful responses use `{ "data": ... }`. Invalid dates return `400 INVALID_DATE`; unknown stops return `404 STOP_NOT_FOUND`.
