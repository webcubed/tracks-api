# Journey planning

`GET /v1/journey` finds up to five itineraries using the static timetable, ranked by earliest arrival or user preference (`fastest`, `fewerTransfers`, `lessWalking`).

The planner searches scheduled trips in the subway, LIRR, and bus feeds, linking nearby stations and stops with walking transfers. It allows up to four rides per itinerary, including mixed-mode routes such as a bus-to-subway connection or LIRR-to-shuttle-to-subway. Search labels preserve distinct route patterns, so the five results can show different ways to make a trip rather than five departures using the same transfer. Results use scheduled GTFS timetables, not live GTFS-Realtime arrival predictions; they do not account for delays, cancellations, or vehicle positions.

In-complex transfers use `transfers.txt` durations where published, while street transfers compute pedestrian walking distance and duration (up to 600 metres). Every itinerary includes both `legs` (ride legs only, for backwards compatibility) and `steps` (ordered `ride` and `walk` steps with distances, durations, and coordinates).

### Why is journey planning not realtime?

The current planner scans static GTFS `stop_times` and service calendars for the requested `date` and `time`. Realtime is exposed separately through [`arrivals`](/arrivals), [`vehicles`](/vehicles), and [`alerts`](/alerts); those endpoints do not feed predictions into the journey search.

Making a multi-leg itinerary delay-aware takes more than replacing scheduled times with a live arrival: the planner needs to reconcile realtime trip updates with scheduled trips, propagate delay or cancellation changes along a candidate itinerary, and decide how skipped stops, missing updates, and transfers affect feasible connections. That integration has not been implemented, so journeys are timetable estimates and do not account for live delays, cancellations, or vehicle positions. There is no inherent API constraint preventing a future realtime-aware planner.

## Query parameters

| Parameter | Required | Description |
| --- | --- | --- |
| `from` | Yes | Origin stop ID. |
| `to` | Yes | Destination stop ID. |
| `date` | No | Service date in `YYYY-MM-DD`; defaults to today. |
| `time` | No | New York local time in `HH:MM:SS`; defaults to now. |
| `fromAgency` | No | Pin the origin feed to resolve a colliding stop ID. |
| `toAgency` | No | Pin the destination feed to resolve a colliding stop ID. |
| `preference` | No | Ranking order: `fastest` (default), `fewerTransfers`, or `lessWalking`. |
| `modes` | No | Comma-separated transit modes to include: `subway`, `rail`, `bus`. |

## Examples

```sh
curl 'https://your-api.example/v1/journey?from=127&to=102'
curl 'https://your-api.example/v1/journey?from=237&to=102&fromAgency=lirr&toAgency=subway&date=2026-09-26&time=08:30:00&preference=fewerTransfers&modes=subway,rail'
```

The response identifies the resolved origin and destination, date and time, and an `itineraries` list. Each itinerary includes departure time, arrival time, duration in minutes, total walking duration/distance, transfer count, ride `legs`, and full `steps`.

## Response shape

```json
{
  "data": {
    "from": { "id": "127", "name": "Times Sq-42 St" },
    "to": { "id": "102", "name": "Jamaica" },
    "date": "2026-09-26",
    "time": "08:30:00",
    "itineraries": [
      {
        "departureTime": "08:34:00",
        "arrivalTime": "09:02:00",
        "durationMinutes": 28,
        "walkingDurationSeconds": 259,
        "walkingDistanceMeters": 268,
        "transfers": 1,
        "legs": [
          {
            "route": "2",
            "agency": "subway",
            "headsign": "Flatbush Av-Brooklyn College",
            "direction": "southbound",
            "tripId": "sample-subway-trip",
            "stops": 1,
            "from": { "id": "127", "name": "Times Sq-42 St", "time": "08:34:00" },
            "to": { "id": "128", "name": "34 St-Penn Station", "time": "08:35:30" }
          },
          {
            "route": "1",
            "agency": "lirr",
            "headsign": "Babylon",
            "direction": "eastbound",
            "tripId": "sample-lirr-trip",
            "stops": 2,
            "from": { "id": "237", "name": "Penn Station", "time": "08:42:00" },
            "to": { "id": "102", "name": "Jamaica", "time": "09:02:00" }
          }
        ],
        "steps": [
          {
            "kind": "ride",
            "durationSeconds": 90,
            "route": "2",
            "agency": "subway",
            "headsign": "Flatbush Av-Brooklyn College",
            "direction": "southbound",
            "tripId": "sample-subway-trip",
            "stops": 1,
            "from": { "id": "127", "name": "Times Sq-42 St", "time": "08:34:00" },
            "to": { "id": "128", "name": "34 St-Penn Station", "time": "08:35:30" }
          },
          {
            "kind": "walk",
            "distanceMeters": 268,
            "durationSeconds": 259,
            "transferType": "street",
            "from": {
              "id": "128",
              "name": "34 St-Penn Station",
              "agency": "subway",
              "time": "08:35:30",
              "location": { "lat": 40.750373, "lon": -73.991057 }
            },
            "to": {
              "id": "237",
              "name": "Penn Station",
              "agency": "lirr",
              "time": "08:39:49",
              "location": { "lat": 40.75058, "lon": -73.99358 }
            }
          },
          {
            "kind": "ride",
            "durationSeconds": 1200,
            "route": "1",
            "agency": "lirr",
            "headsign": "Babylon",
            "direction": "eastbound",
            "tripId": "sample-lirr-trip",
            "stops": 2,
            "from": { "id": "237", "name": "Penn Station", "time": "08:42:00" },
            "to": { "id": "102", "name": "Jamaica", "time": "09:02:00" }
          }
        ]
      }
    ]
  }
}
```

An itinerary can have up to four ride legs. `itineraries` is empty when no route is found (or the origin and destination are effectively the same).

Missing `from` or `to` returns `400 MISSING_FROM` or `400 MISSING_TO`. Invalid dates, times, preferences, or mode filters return `400`. Unknown stops return `404 STOP_NOT_FOUND`; unknown feed IDs return `404 AGENCY_NOT_FOUND`.
