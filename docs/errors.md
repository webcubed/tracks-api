# Errors

API errors use the JSON envelope:

```json
{
  "error": {
    "code": "STOP_NOT_FOUND",
    "message": "No stop found with id 'unknown'"
  }
}
```

## Error codes

| HTTP status | Codes | Meaning |
| --- | --- | --- |
| `400` | `MISSING_STOP`, `MISSING_ROUTE`, `MISSING_FROM`, `MISSING_TO` | A required query parameter is missing. |
| `400` | `INVALID_DATE`, `INVALID_TIME`, `INVALID_LOCATION` | A date, time, or set of proximity parameters is invalid. |
| `404` | `AGENCY_NOT_FOUND`, `ROUTE_NOT_FOUND`, `STOP_NOT_FOUND` | The requested resource does not exist. Unknown journey origin/destination IDs use `STOP_NOT_FOUND`. |
| `502` | `FEED_UNAVAILABLE` | An upstream realtime feed failed. |
| `500` | `INTERNAL_ERROR` | An unexpected server error occurred. |

Successful responses use `{ "data": ... }`. Error responses do not use a `data` property.
