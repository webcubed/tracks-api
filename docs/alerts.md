# Alerts

`GET /v1/alerts` returns active MTA service alerts.

## Query parameters

| Parameter | Required | Description |
| --- | --- | --- |
| `agency` | No | Filter by feed ID. |
| `route` | No | Filter to alerts that list this route. |

Alert objects include ID, agency, affected routes, severity, cause, effect, and a header. Description and active period are included when available.

```sh
curl 'https://your-api.example/v1/alerts'
curl 'https://your-api.example/v1/alerts?agency=subway&route=1'
```

Success uses `{ "data": ... }`; an invalid agency returns `404 AGENCY_NOT_FOUND`. Realtime upstream errors use `502 FEED_UNAVAILABLE`.
