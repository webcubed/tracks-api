# Agencies

Agencies are the feed keys used by the API, not the raw GTFS `agency_id` values.

## Endpoints

| Method and path | Description |
| --- | --- |
| `GET /v1/agencies` | List all eight transit feeds. |
| `GET /v1/agencies/:id` | Retrieve one feed by ID. |

## Agency IDs

| ID | Feed |
| --- | --- |
| `subway` | New York City Subway |
| `lirr` | Long Island Rail Road |
| `bus_bx` | MTA Bus - Bronx |
| `bus_b` | MTA Bus - Brooklyn |
| `bus_busco` | MTA Bus Company |
| `bus_m` | MTA Bus - Manhattan |
| `bus_si` | MTA Bus - Staten Island |
| `bus_q` | MTA Bus - Queens |

## Examples

```sh
curl https://your-api.example/v1/agencies
curl https://your-api.example/v1/agencies/subway
```

## Response shape

`GET /v1/agencies` returns an array; `GET /v1/agencies/:id` returns one object. Both use the same success envelope:

```json
{
  "data": [
    {
      "id": "subway",
      "name": "New York City Subway",
      "url": "https://new.mta.info/",
      "timezone": "America/New_York",
      "modes": ["subway"]
    }
  ]
}
```

An unknown ID returns `404` with `AGENCY_NOT_FOUND`.
