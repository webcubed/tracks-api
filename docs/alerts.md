# Alerts

`GET /v1/alerts` returns active MTA service alerts.

## Query parameters

| Parameter | Required | Description |
| --- | --- | --- |
| `agency` | No | Filter by feed ID. |
| `route` | No | Filter to alerts that list this route. |

Alert objects include ID, agency, affected routes, severity, cause, effect, and a header. Description and active period are included when available. The current source does not supply normalized GTFS-RT cause/effect/severity fields: `cause` is reported as `"unknown"`, and severity/effect are inferred from the MTA alert type.

## Response shape

`data` is an array. `description` and `activePeriod` are omitted when not available.

```json
{
  "data": [
    {
      "id": "sample-alert-id",
      "agency": "subway",
      "routes": ["1", "2", "3"],
      "severity": "high",
      "cause": "unknown",
      "effect": "delays",
      "header": "Sample service advisory",
      "description": "Example alert text.",
      "activePeriod": {
        "start": "2026-09-26T08:00:00-04:00",
        "end": "2026-09-26T12:00:00-04:00"
      }
    }
  ]
}
```

The sample illustrates the shape; alert contents and active periods are live feed data.

```sh
curl 'https://your-api.example/v1/alerts'
curl 'https://your-api.example/v1/alerts?agency=subway&route=1'
```

Success uses `{ "data": ... }`; an invalid agency returns `404 AGENCY_NOT_FOUND`. Realtime upstream errors use `502 FEED_UNAVAILABLE`.
