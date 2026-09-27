# Journey planning

`GET /v1/journey` finds up to five earliest-arrival itineraries using the static timetable.

The planner supports subway and LIRR as ride legs. Nearby stops across feeds and stations can be linked by walking; bus stops can be walk connections, but bus rides are not included as itinerary legs. It plans up to three rides per itinerary.

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

Missing `from` or `to` returns `400 MISSING_FROM` or `400 MISSING_TO`. Invalid dates and times return `400 INVALID_DATE` and `400 INVALID_TIME`. Unknown stops return `404 STOP_NOT_FOUND`; unknown feed IDs return `404 AGENCY_NOT_FOUND`.
