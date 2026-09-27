---
lastSync: Sun May 24 2026 12:48:46 GMT-0400 (Eastern Daylight Time)
---
## Endpoint: `https://otp-mta-prod.camsys-apps.com/otp/routers/default/nearby`

## Parameters
- `timeRange`: presumably ms, defaults to 21600 on their website
- `apikey`: `[redacted credential; do not commit API keys]`
### Without ?stops
- `lat`: latitude of center of search area
- `lon`: longitude of center of search area
- `radius`: range of search
- `mode`: Required, but can be empty. `SUBWAY`, `RAIL`, or `BUS`
### With ?stops
- `stops`: Format: `MODE:StopID`
	- Mode can be `MTA` (bus), `MTASUBWY` (subway), `LI` (LIRR), `NJT` (new jersey transit), `path-nj-us` (path train), `MNR` (metro north)
	- stop id is a number
## Response format (AI generated)

### Without `?stops` (Coordinate-based search)
Returns a JSON array of station/stop objects located within the specified `radius` of your `lat`/`lon`. Because this relies on geographic routing from a center point, the `stop` object includes walking distance, walking time, and path geometry.

### With `?stops` (Direct Stop ID search)
Returns a JSON array of the explicitly requested stop(s). The structure is identical to the coordinate-based search, **except** it omits the routing fields (`dist`, `geometry`, and `walkTime`) since there is no origin point to calculate a walk from. It may also include additional static links (like `url` to the MTA station page).

---

### Shared Response Structure (Array of Objects)
The root of the response is an Array of Objects. Each object represents a single transit stop or station hub and contains three main keys: `stop`, `alerts`, and `groups`.

#### 1. `stop` (Object)
Contains static details about the physical transit stop.
*   `id`: *(String)* The unique identifier for the stop, usually prefixed by the agency/mode (e.g., `"MTA:403253"`, `"LI:3"`).
*   `name`: *(String)* The human-readable name of the station/stop (e.g., `"Grand Central"`).
*   `code`: *(String, optional)* A short alphanumeric code for the station (e.g., `"GCT"`).
*   `lat` / `lon`: *(Float)* Geographic coordinates of the stop.
*   `parentStation`: *(String, optional)* The ID of the parent station complex, if this is a sub-stop of a larger hub.
*   `url`: *(String, optional)* A direct URL to the MTA's info page for this station.
*   **Geographic Fields (Only present *without* `?stops`):**
    *   `dist`: *(Integer)* Straight-line distance from the search center to the stop, in meters.
    *   `walkTime`: *(Integer)* Estimated walking time from the search center, in seconds.
    *   `geometry`: *(Object)* Contains `points` (an encoded polyline string for map rendering) and `length` (number of nodes in the path) for the walking route.

#### 2. `alerts` (Array of Objects)
A list of active MTA service alerts affecting this specific stop. If there are no alerts, this array is empty.
*   `id`: *(String)* Unique internal identifier for the alert.
*   `alertType`: *(String)* Category of the alert (e.g., `"Sunday Schedule"`, `"Planned - Stops Skipped"`, `"Expect Delays"`).
*   `alertHeaderText`: *(String)* The title or headline of the alert.
*   `alertDescriptionText`: *(String)* In-depth details regarding the service change, alternatives, or detour routes.
*   `humanReadableActivePeriod`: *(String)* Formatted string explaining when the alert is active (e.g., `"May 25, Monday, Memorial Day"`).
*   `effectiveStartDate` / `effectiveEndDate`: *(Integer)* Unix epoch timestamps (in **milliseconds**) for the alert's active period.
*   `createdAtDate` / `updatedAtDate`: *(Integer)* Unix epoch timestamps (in **milliseconds**) for when the alert was published or modified.
*   `stationAlternates`: *(Array of Objects, optional)* Alternative stops recommended during a bypass. Contains `notes`, `agencyId`, and `stopId`.

#### 3. `groups` (Array of Objects)
The core real-time data. This groups upcoming vehicle arrivals/departures by route (e.g., grouping all upcoming "M42" buses or "LIRR Babylon" trains together).

**Inside each `group` object:**
*   `headsign`: *(String)* The general destination for this group of vehicles (e.g., `"Grand Central"`, `"WEST SIDE PIER 12 AV CROSSTOWN"`).
*   `stopHeadsign`: *(Boolean)* Indicates if the stop itself dictates the headsign direction.
*   `route`: *(Object)* Metadata about the transit line:
    *   `id`: *(String)* Route ID (e.g., `"MTA:M42"`, `"LI:1"`, `"MTASBWY:GS"`).
    *   `shortName`: *(String)* Public route name/number (e.g., `"M42"`, `"S"`, `"6"`).
    *   `longName`: *(String)* Full name of the route (e.g., `"Babylon Branch"`).
    *   `mode`: *(String)* Transit type (`"BUS"`, `"RAIL"`, `"SUBWAY"`).
    *   `color`: *(String)* Hexadecimal color code for the route badge (without the `#`).
    *   `agencyName`: *(String)* Operating agency (e.g., `"Long Island Rail Road"`, `"MTA New York City Transit"`).
    *   `routeType`: *(Integer)* Standard GTFS route type (1 = Subway, 2 = Rail, 3 = Bus, 702 = Express Bus).

*   `times`: *(Array of Objects)* The specific scheduled and real-time trips arriving at this stop.
    *   `tripId`: *(String)* Unique identifier for this specific trip/run.
    *   `tripHeadsign`: *(String)* The destination sign on the front of this specific vehicle.
    *   `serviceDay`: *(Integer)* Unix epoch timestamp (in **seconds**) representing midnight of the current operational day.
    *   `scheduledArrival` / `scheduledDeparture`: *(Integer)* Time the vehicle is scheduled to arrive/depart, represented in **seconds since midnight** of the `serviceDay`.
    *   `realtimeArrival` / `realtimeDeparture`: *(Integer)* Real-time prediction of arrival/departure, represented in **seconds since midnight** of the `serviceDay`.
    *   `arrivalDelay` / `departureDelay`: *(Integer)* Delay in seconds (negative numbers indicate the vehicle is early).
    *   `arrivalFmt` / `departureFmt`: *(String)* Pre-formatted, human-readable ISO-8601 timestamps (e.g., `"2026-05-24T12:45:17-04:00"`). *Use this field if you want to avoid doing math with `serviceDay` and `realtimeArrival`.*
    *   `realtime`: *(Boolean)* `true` if the system is actively tracking the vehicle, `false` if it is falling back to the schedule.
    *   `realtimeState`: *(String)* Enum indicating schedule status (`"UPDATED"`, `"SCHEDULED"`, `"ADDED"`).
    *   `timestamp`: *(Integer)* Unix epoch timestamp (in **seconds**) of when the real-time prediction was generated.
    *   `stopIndex`: *(Integer)* Which number stop this is along the vehicle's total route.
    *   `stopCount`: *(Integer)* Total number of stops on this trip.
    *   `track`: *(String, optional)* Track number the train will arrive on (mostly applicable to LIRR/Metro-North/Terminal subway stations).
    *   `vehicleInfo`: *(Object, optional)* Real-time data regarding the physical vehicle (useful for maps or crowding info):
        *   `vehicleId` / `vehicleLabel`: *(String)* The physical ID/number of the bus or train car.
        *   `lat` / `lon`: *(Float)* Current live coordinates of the vehicle.
        *   `bearing`: *(Float)* Compass direction the vehicle is traveling.
        *   `currentStopStatus`: *(String)* Enum detailing vehicle state (`"IN_TRANSIT_TO"`, `"STOPPED_AT"`, `"INCOMING_AT"`).
        *   `occupancyStatus`: *(String)* High-level crowding metric (e.g., `"EMPTY"`, `"MANY_SEATS_AVAILABLE"`).
        *   `carriages`: *(Array of Objects)* Car-by-car crowding data for trains (contains `label` and `occupancyStatus` for each train car).