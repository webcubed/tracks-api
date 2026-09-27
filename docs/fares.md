# Fares

`GET /v1/fares` returns a curated fare reference for all supported feeds or one selected feed.

## Query parameters

| Parameter | Required | Description |
| --- | --- | --- |
| `agency` | No | Limit the response to one feed ID. |

Fare records can include a name, amount, currency, and note. Some rail prices vary by zone or peak period and therefore omit a fixed amount.

```sh
curl 'https://your-api.example/v1/fares'
curl 'https://your-api.example/v1/fares?agency=lirr'
```

The MTA does not publish fare tables in its GTFS feeds, so these values are curated from MTA fare information and may change. Confirm prices with MTA before travel. An invalid agency returns `404 AGENCY_NOT_FOUND`.
