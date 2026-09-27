---
lastSync: Tue Aug 26 2025 13:20:47 GMT-0400 (Eastern Daylight Time)
---
## OBA Base URL:  `https://bustime.mta.info/api/where`

## SIRI Base URL:  `https://bustime.mta.info/api/siri`

Methods are based off of this documentation: https://developer.onebusaway.org/api/where/methods

Pass information via URL parameters

Always specify `key`, can be obtained via google form: https://register.developer.obanyc.com/

^ Funny thing you can do: since bustime website also uses the same apis, the key they use is "OBANYC"

but heres mine: `[redacted credential; do not commit API keys]`

## Step 1. Finding stops nearby (preferably nearest)
### The endpoint to use:

`/stops-for-location.json` (can also be .xml, json better parsing)

*key required*

#### Parameters:
- `lat` - The latitude coordinate of the search center
- `lon` - The longitude coordinate of the search center
- `radius` - The search radius in meters (optional)
- `latSpan`/`lonSpan` - An alternative to `radius` to set the search bounding box (optional)
- `query` - A specific stop code to search for (optional)
This *will* return an object w/ a list of nearby stops. Each entry is the same object returned when fetching `/stop/<id>.json`
example stop id: Q28 from chrocheron/168th -> West: `501765`
## Step 2. Finding Arrivals (also preferably nearest)
### Endpoint: We will use the SIRI endpoint

It provides data on vehicles serving a stop. We can use the same key and same stop ids identified from the previous step

### Parameters
- **key** - your MTA Bus Time developer API key (**required**).  Go [here](https://register.developer.obanyc.com) to get one.

- `version` - which version of the SIRI API to use (1 or 2). Defaults to 1, but 2 is preferrable.

- `OperatorRef` - the GTFS agency ID to be monitored (optional).  Currently, all stops have operator/agency ID of MTA. If left out, the system will make a best guess. Usage of the OperatorRef is suggested, as calls will return faster when populated.

- **MonitoringRef** - the GTFS stop ID of the stop to be monitored (**required**).  For example, *308214* for the stop at 5th Avenue and Union St towards Bay Ridge. (so just the code, no `MTA_`)

- `LineRef` - a filter by 'fully qualified' route name, GTFS agency ID + route ID (e.g. MTA NYCT_B63).

- `DirectionRef` - a filter by GTFS direction ID (optional).  Either 0 or 1.

- `StopMonitoringDetailLevel` - Level of detail present in response. In order of verbosity:  
	minimum - only available in version 2. Designed for front-end use.  
	basic - only available in version 2. Designed for system-to-system interchange when GTFS is loaded.  
	normal - default.  
	calls Determines whether or not the response will include the stops ("calls" in SIRI-speak) each vehicle is going to make **after** it serves the selected stop (optional).

- `MaximumNumberOfCallsOnwards` - Limits the number of OnwardCall elements returned in the query.

- `MaximumStopVisits` - an upper bound on the number of buses to return in the results.

- `MinimumStopVisitsPerLine` - a lower bound on the number of buses to return in the results per line/route (assuming that many are available)
