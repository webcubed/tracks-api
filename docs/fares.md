# Fares

`GET /v1/fares` returns a curated fare reference for all supported feeds or one selected feed.

## Query parameters

| Parameter | Required | Description |
| --- | --- | --- |
| `agency` | No | Limit the response to one feed ID. |

`data` is an array of agency records. Fare records include a name and currency; `amount` and `note` are optional. Some rail prices vary by zone or peak period and therefore omit a fixed amount.

## Response shape

```json
{
  "data": [
    {
      "agency": "lirr",
      "mode": "rail",
      "fares": [
        {
          "name": "CityTicket off-peak (within NYC)",
          "amount": 5.25,
          "currency": "USD",
          "note": "One-way, no direction change inside New York City"
        },
        {
          "name": "Zone fare",
          "currency": "USD",
          "note": "Varies by stations and peak/off-peak"
        }
      ]
    }
  ]
}
```

```sh
curl 'https://your-api.example/v1/fares'
curl 'https://your-api.example/v1/fares?agency=lirr'
```

The MTA does not publish fare tables in its GTFS feeds, so these values are curated from MTA fare information and may change. Confirm prices with MTA before travel. An invalid agency returns `404 AGENCY_NOT_FOUND`.
