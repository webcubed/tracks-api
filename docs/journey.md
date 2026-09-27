# Journey planning

`GET /v1/journey` finds up to five earliest-arrival itineraries using the static timetable.

The planner supports subway and LIRR as ride legs. Nearby stops across feeds and stations can be linked by walking; bus stops can be walk connections, but bus rides are not included as itinerary legs. It plans up to three rides per itinerary. It also uses scheduled GTFS timetables, not live GTFS-Realtime arrival predictions; a journey can therefore be planned from the timetable but does not currently account for realtime delays, cancellations, or vehicle positions.

### Why are bus legs not supported?

This is a current implementation limit, not a lack of MTA bus data: bus schedules and realtime feeds are available to other API endpoints. The journey search only boards trips from the subway and LIRR feeds. It loads bus stops into the spatial network so a bus stop can be a walk-linked origin, destination, or transfer point, but does not scan bus timetables for ride legs.

Supporting bus rides means extending the round-based search to scan the borough bus feeds, find boardable trips, and include their stop sequences and transfer/wait times when ranking itineraries. The planner has not had that extension implemented yet; bus legs are not silently inferred from nearby bus stops.

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

## Examples

```sh
curl 'https://your-api.example/v1/journey?from=127&to=102'
curl 'https://your-api.example/v1/journey?from=237&to=102&fromAgency=lirr&toAgency=subway&date=2026-09-26&time=08:30:00'
```

The response identifies the resolved origin and destination, date and time, and an `itineraries` list. Each itinerary includes departure time, arrival time, duration in minutes, and its ride legs.

## Response shape

Walks are implicit and do not appear as legs; a change of station/agency between consecutive ride legs represents the transfer. Times below illustrate the output format.

```json
{
  "data": {
    "from": { "id": "127", "name": "Times Sq-42 St" },
    "to": { "id": "A12", "name": "34 St-Penn Station" },
    "date": "2026-09-26",
    "time": "08:30:00",
    "itineraries": [
      {
        "departureTime": "08:32:00",
        "arrivalTime": "08:41:00",
        "durationMinutes": 9,
        "legs": [
          {
            "route": "1",
            "agency": "subway",
            "headsign": "South Ferry",
            "direction": "southbound",
            "tripId": "sample-trip-id",
            "from": { "id": "127", "name": "Times Sq-42 St", "time": "08:32:00" },
            "to": { "id": "A12", "name": "34 St-Penn Station", "time": "08:41:00" }
          }
        ]
      }
    ]
  }
}
```

An itinerary can have up to three rail legs. `itineraries` is empty when no route is found (or the origin and destination are effectively the same).

Missing `from` or `to` returns `400 MISSING_FROM` or `400 MISSING_TO`. Invalid dates and times return `400 INVALID_DATE` and `400 INVALID_TIME`. Unknown stops return `404 STOP_NOT_FOUND`; unknown feed IDs return `404 AGENCY_NOT_FOUND`.
