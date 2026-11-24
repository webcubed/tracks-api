# History and analytics

The rest of the API describes now. These endpoints answer questions about the past: which trains pulled a car, where it went, how late a line actually runs, and how often service comes.

Live data is held for fifteen seconds and then gone, so the history lives in object storage. Two datasets are archived, and only two: what a timetable cannot reproduce.

## What is recorded

| Dataset      | One row per                 | Columns                                                                            |
| ------------ | --------------------------- | ---------------------------------------------------------------------------------- |
| `lirr_fleet` | live LIRR train, per sample | time, train number, branch, fleet, car numbers, position, next stop, track section |
| `arrivals`   | trip and stop, per sample   | time, agency, route, trip, stop, scheduled time, predicted time, delay in seconds  |

The consist is what makes a car traceable: a car number appears in the feed only as part of the train pulling it. Track section (for example `GDN:HM`) says where between stations the train was.

Arrival rows are deduplicated before they are written. A prediction is kept when it is new, when its delay has moved by a minute, or when five minutes have passed since the last one. A train holding at two minutes late for half an hour is one row, not thirty. Fleet rows are never collapsed, because the car trace is the sequence of positions.

Bus reliability is deliberately not recorded. The bus feed publishes arrival predictions for stops a rider asks about, not a per-trip stop list, so there is no stable prediction to compare against the timetable.

## Where it lives

```text
<ARCHIVE_PREFIX>/lirr_fleet/dt=2026-11-17/part-1794956625-cc8461e0.parquet
<ARCHIVE_PREFIX>/arrivals/dt=2026-11-17/part-1794956625-7e91f376.parquet
```

One directory per UTC day, one immutable file per flush, named by the epoch of its first row. A part is never rewritten, so a listing sorts in time order and a cached download never goes stale. A query lists the day prefixes its window touches, keeps only the parts whose epoch falls inside the window, and downloads those to a local cache before DuckDB reads them.

The bucket is any S3-compatible store; this deployment uses Backblaze B2.

## Running the recorder

Recording is a separate process. The API sleeps on free hosting, and a recorder that only ran inside it would leave a hole in the archive every night.

```sh
pnpm record              # sample every ARCHIVE_SAMPLE_MS, flush every ARCHIVE_FLUSH_MS
pnpm record --once       # one sample, one flush, then exit
pnpm record --probe      # parts, bytes and time span in the bucket
```

A failed upload returns its rows to the buffer and is retried on the next flush, and the upload itself retries server errors, so a short storage outage delays the archive instead of losing a part.

| Variable                        | Default  | Meaning                                                         |
| ------------------------------- | -------- | --------------------------------------------------------------- |
| `B2_ENDPOINT`                   | required | S3 origin, for example `https://s3.us-east-005.backblazeb2.com` |
| `B2_REGION`                     | required | Signing region, for example `us-east-005`                       |
| `B2_KEY_ID`                     | required | Application key ID                                              |
| `B2_APP_KEY`                    | required | Application key                                                 |
| `B2_BUCKET`                     | required | Bucket name                                                     |
| `ARCHIVE_PREFIX`                | `v1`     | Key prefix for every dataset                                    |
| `ARCHIVE_SAMPLE_MS`             | `60000`  | Time between feed samples                                       |
| `ARCHIVE_FLUSH_MS`              | `900000` | Time between uploads                                            |
| `ARCHIVE_DUCKDB`                | unset    | `shared` puts archive reads on the live DuckDB connection       |
| `ARCHIVE_DUCKDB_MEMORY_LIMIT`   | `128MB`  | Memory ceiling for the archive connection                       |
| `FREQUENCY_DUCKDB`              | unset    | `shared` puts timetable scans on the live DuckDB connection     |
| `FREQUENCY_DUCKDB_MEMORY_LIMIT` | `128MB`  | Memory ceiling for the timetable connection                     |

Without the `B2_*` variables, the endpoints below answer `503` with code `ARCHIVE_NOT_CONFIGURED`; the rest of the API is unaffected.

## Endpoints

### `GET /v1/analytics/coverage`

What the bucket holds. `sharesLiveConnection` reports whether archive reads are sharing the live DuckDB connection.

```json
{
	"data": {
		"prefix": "v1",
		"sharesLiveConnection": false,
		"datasets": [
			{
				"dataset": "lirr_fleet",
				"parts": 96,
				"bytes": 560253,
				"first": "2026-11-16T23:00:00.000Z",
				"last": "2026-11-17T22:45:00.000Z"
			}
		]
	}
}
```

### `GET /v1/analytics/fleet?car=7756&hours=24`

Where one car has been. `hours` is 1 to 48 and defaults to 24.

```json
{
	"data": {
		"car": 7756,
		"hours": 24,
		"window": {
			"from": "2026-11-16T23:10:00.000Z",
			"to": "2026-11-17T23:10:00.000Z"
		},
		"samples": 141,
		"firstSeen": "2026-11-16T23:15:00.000Z",
		"lastSeen": "2026-11-17T22:45:00.000Z",
		"km": 118.4,
		"fleet": "M7",
		"branches": [{ "id": "2", "name": "Hempstead Branch" }],
		"trains": ["786"],
		"segments": [
			{
				"train": "786",
				"branch": "2",
				"branchName": "Hempstead Branch",
				"fleet": "M7",
				"from": "2026-11-16T23:15:00.000Z",
				"to": "2026-11-17T01:40:00.000Z",
				"minutes": 145,
				"km": 74.2,
				"headingTo": "Hempstead",
				"section": "GDN:HM"
			}
		]
	}
}
```

A segment breaks when the car changes train, changes branch, or stops reporting for ten minutes. `km` is the sum of straight-line distances between consecutive samples, so it undercounts curves and terminal turns. An unknown car returns `samples: 0` rather than an error; a non-numeric car is `400 INVALID_CAR`.

### `GET /v1/analytics/reliability?agency=lirr&route=2&hours=24`

Delay as it stands now for each trip and stop: the newest prediction wins, so a train that recovered before arrival is judged on arrival. `agency` and `route` are optional.

```json
{
	"data": {
		"agency": "lirr",
		"route": "2",
		"hours": 24,
		"window": { "from": "...", "to": "..." },
		"onTimeThresholdSeconds": 300,
		"samples": 1682,
		"onTimeRate": 0.941,
		"medianDelaySeconds": 0,
		"p90DelaySeconds": 240,
		"meanDelaySeconds": 62,
		"routes": [
			{
				"route": "2",
				"samples": 1682,
				"onTimeRate": 0.941,
				"medianDelaySeconds": 0,
				"p90DelaySeconds": 240,
				"meanDelaySeconds": 62
			}
		],
		"stops": [
			{
				"route": "2",
				"stop": "123",
				"samples": 210,
				"onTimeRate": 0.876,
				"medianDelaySeconds": 0,
				"p90DelaySeconds": 300,
				"meanDelaySeconds": 104
			}
		]
	}
}
```

A stop is on time within five minutes either way, so a train early by more than five minutes counts as not on time. `stops` is sorted worst first.

### `GET /v1/analytics/stops/127?agency=subway&hours=24`

The same measures for one station, across every route and platform it serves, with a per-route breakdown. An unknown stop is `404 STOP_NOT_FOUND`.

### `GET /v1/analytics/frequency?agency=subway&route=1&date=2026-11-17`

How often service runs. `route` narrows to one route's first departures; `stop` counts every trip calling there instead. `date` defaults to today in New York.

```json
{
	"data": {
		"agency": "subway",
		"date": "2026-11-17",
		"route": "1",
		"trips": 462,
		"source": "timetable",
		"routes": [
			{
				"route": "1",
				"trips": 462,
				"firstDeparture": "00:00:00",
				"lastDeparture": "24:58:00",
				"peakHeadwayMinutes": 0.5,
				"medianHeadwayMinutes": 2.5,
				"tripsPerHour": [{ "hour": "05", "trips": 18 }]
			}
		]
	}
}
```

Each route in the report carries the feed's own `longName` and `shortName`, so a client that has not loaded a feed's route list can still name the route.

`agency=bus` merges the six borough feeds into one report for the whole bus network: `route` filters inside every feed, and a `stop` still needs its borough feed (`400 AGENCY_REQUIRED` otherwise). Reading all six costs seconds of remote parquet, so each feed's timetable is scanned once per date and shared with any request already scanning it, and the merged bus report is built at startup and rebuilt by the hourly refresh. Warm, it answers in a few milliseconds.

The hourly rebuild matters because a report is not final for its date: the supplemented timetable behind it is republished hourly, so a report built at 09:00 describes the feed as it stood then. Rebuilding it every hour keeps it within an hour of the published timetable. That is affordable because the scans run on their own DuckDB connection, measured below: sharing the live connection made a live request wait behind them.

## Why frequency comes from the timetable

The archive answers reliability and car history because no timetable can. Frequency is the opposite: the timetable answers it exactly, for any date including tomorrow, in one query. A recorded headway could only describe the days the recorder happened to be running, which is strictly less than what the operator published. So `frequency` reads `trips` and `stop_times` for the date, and everything else here reads the archive.

## Measured cost of a 24-hour window

Measured on a synthetic day at real volume: 96 flushes per dataset, 0.53 MB of fleet parts and 0.40 MB of arrival parts, 1,410 samples for one car, 470,400 arrival rows before deduplication. The real archive only held a few minutes of history, so the volume was generated to the counts a real day produces.

| Request                          | Cold cache | Warm cache |
| -------------------------------- | ---------- | ---------- |
| `coverage`                       | 0.26 s     | 0.26 s     |
| `fleet?car=&hours=24` (94 parts) | 1.60 s     | 0.09 s     |
| `reliability?hours=24`           | 1.46 s     | 0.21 s     |
| `stops/127?hours=24`             | 0.20 s     | 0.20 s     |
| `frequency` (462 trips)          | 1.48 s     | 1.48 s     |

Cold means no part is on disk yet; the 1.5 s is almost entirely the sequential download of 94 small objects, and the downloads do not hold the DuckDB connection. The scan itself costs about 110 ms.

Archive reads use their own DuckDB connection, because the live connection serializes every query on one queue. Measured with both requests in flight:

- Separate connection: the archive query finishes in about 110 ms warm and a live request stays at its normal 420 to 500 ms.
- `ARCHIVE_DUCKDB=shared`: the archive query waits behind the live query (about 500 ms instead of 110 ms), and a live request issued during the archive scan waits for it.

The wait equals the scan time, which grows with the number of parts in the window, so a month of history would push live requests around by seconds. That is why the separate connection is the default, at a cost of one extra 128 MB DuckDB instance per process.

Timetable scans need the same isolation for the same reason: one bus report reads six feeds' `stop_times`. Measured with a six-feed scan in flight and a `/v1/stops/127/schedule` request every 250 ms:

| Mode                      | Live request median             | Live request max | Scan         |
| ------------------------- | ------------------------------- | ---------------- | ------------ |
| Own connection (default)  | 436 to 443 ms (441 ms baseline) | 486 to 771 ms    | 3.1 to 4.9 s |
| `FREQUENCY_DUCKDB=shared` | 984 to 1176 ms                  | 2.1 s            | 7.6 to 8.2 s |

The shared queue delays a live request by about one feed's scan rather than the whole report, because the six feeds are six separate queries — and it stretches the scan itself, as the two workloads take turns. On its own connection the rebuild is invisible to live traffic, which is what makes rebuilding it hourly affordable. The extra instance is limited to 128 MB but measured about 15 MB of extra RSS (433 MB peak against 418 MB).

## Limits

- The window is capped at 48 hours. Longer ranges mean a larger scan and belong on a server with a real disk and more memory.
- A car's distance is sample to sample, so it is a lower bound.
- Reliability depends on the recorder keeping up. A gap in the archive is a gap in the numbers, and `samples` shows it.
- Subway and bus frequency are read live from the published timetable, so they are exact for any date but say nothing about what actually ran.
