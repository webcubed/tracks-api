---
lastSync: Sun May 24 2026 15:39:47 GMT-0400 (Eastern Daylight Time)
---
the following is ai generated
# LIRR Locations API Documentation

**Endpoint:** `GET https://backend-unified.mylirr.org/locations?geometry=TRACK_TURF&railroad=LIRR`

## Overview
This endpoint returns real-time data for Long Island Rail Road (LIRR) trains currently in operation. The payload is a JSON array of `Train` objects, each containing comprehensive details regarding scheduling, physical train configuration (consist), real-time location telemetry, delays, and applicable service alerts.

---

## 1. Root Object: `Train`
The root response is an array of `Train` objects. 

| Property    | Type      | Description                                                                              |
| :---------- | :-------- | :--------------------------------------------------------------------------------------- |
| `train_id`  | `string`  | Unique identifier for the train's specific run (e.g., `"LIRR_2026-05-24_7560"`).         |
| `railroad`  | `string`  | The operating agency abbreviation (e.g., `"LIRR"`).                                      |
| `run_date`  | `string`  | The scheduled date of the train run (Format: `YYYY-MM-DD`).                              |
| `train_num` | `string`  | The publicly advertised train schedule number (e.g., `"7560"`).                          |
| `realtime`  | `boolean` | Indicates if the tracking data provided is live/real-time.                               |
| `details`   | `object`  | Detailed scheduling, routing, and stop information. (See **Details Object**).            |
| `consist`   | `object`  | Fleet composition, passenger loading, and train length. (See **Consist Object**).        |
| `location`  | `object`  | Telemetry data, GPS coordinates, and speed. (See **Location Object**).                   |
| `status`    | `object`  | On-time performance and operational status. (See **Status Object**).                     |
| `alerts`    | `array`   | *(Optional)* Service alerts affecting this specific train route. (See **Alert Object**). |

---

## 2. Details Object (`details`)
Contains the schedule and routing information for the trip.

| Property    | Type     | Description                                                                                              |
| :---------- | :------- | :------------------------------------------------------------------------------------------------------- |
| `headsign`  | `string` | The final destination displayed on the train (e.g., `"Huntington"`).                                     |
| `summary`   | `string` | A brief summary string showing origin, destination, and times (e.g., `"NYK (2:36 PM) > HUN (3:47 PM)"`). |
| `peak_code` | `string` | Indicates fare code (`"O"` for Off-Peak, `"P"` for Peak).                                                |
| `branch`    | `string` | Human-readable branch name (e.g., `"Port Jefferson"`).                                                   |
| `branch_id` | `string` | Internal branch shorthand (e.g., `"HH"`, `"BY"`, `"FR"`, `"MK"`).                                        |
| `direction` | `string` | Direction of travel (`"E"` for Eastbound, `"W"` for Westbound).                                          |
| `stops`     | `array`  | A chronological list of stops for this trip. (See **Stop Object**).                                      |
| `events`    | `array`  | Internal operational events (often empty `[]`).                                                          |
| `turf`      | `object` | *(Optional)* Operational tracking sector with `length` (number) and `location_mp` (milepost number).     |
| `bike_rule` | `string` | Current bicycle policy on board (`"PERMITTED"`, `"PROHIBITED"`, `"SPECIAL"`).                            |

---

## 3. Stop Object (`stops`)
Represents an individual station stop along the train's route.

| Property          | Type      | Description                                                                                              |
| :---------------- | :-------- | :------------------------------------------------------------------------------------------------------- |
| `code`            | `string`  | Station code abbreviation (e.g., `"NYK"` for Penn Station, `"JAM"` for Jamaica).                         |
| `sched_time`      | `integer` | Scheduled arrival/departure Unix timestamp.                                                              |
| `act_arrive_time` | `integer` | *(Optional)* Actual arrival Unix timestamp.                                                              |
| `act_depart_time` | `integer` | *(Optional)* Actual departure Unix timestamp.                                                            |
| `act_time`        | `integer` | *(Optional)* Consolidated actual time Unix timestamp.                                                    |
| `stop_status`     | `string`  | Current train status relative to the stop (e.g., `"DEPARTED"`, `"EN_ROUTE"`, `"BERTHED"`, `"ARRIVING"`). |
| `stop_type`       | `string`  | Category of stop (e.g., `"STOP"`, `"EARLY_DEPARTURE_3"`, `"EMPLOYEE"`).                                  |
| `sign_track`      | `string`  | Public-facing track assignment (e.g., `"18"`, `"B"`, `"M"`).                                             |
| `avps_track_id`   | `string`  | Audio-Visual Paging System internal track identifier.                                                    |
| `t2s_track`       | `string`  | Text-to-speech or internal sign tracking designation (e.g., `"G2"`, `"R8"`).                             |
| `posted`          | `boolean` | `true` if the track has been officially posted on public departure boards.                               |
| `local_cancel`    | `boolean` | *(Optional)* `true` if the stop was skipped/canceled locally.                                            |
| `bus`             | `boolean` | *(Optional)* `true` if a substitute bus is running for this segment.                                     |
| `occupancy`       | `string`  | *(Optional)* Live crowd level indicator (`"EMPTY"`, `"FEW_SEATS"`, `"NO_DATA"`).                         |
| `track_change`    | `boolean` | *(Optional)* `true` if the track assignment was changed from its usual schedule.                         |

---

## 4. Consist Object (`consist`)
Details the physical makeup of the train and real-time passenger loads.

| Property | Type | Description |
| :--- | :--- | :--- |
| `fleet` | `string` | Class of equipment operating the trip (e.g., `"M7"`, `"M9"`, `"LIRR_DIESEL"`, `"M3"`). |
| `actual_len` | `integer` | Current physical length of the train in cars. |
| `sched_len` | `integer` | Scheduled length of the train in cars. |
| `occupancy` | `string` | Overall train occupancy status (`"EMPTY"`, `"NO_DATA"`). |
| `occupancy_timestamp` | `integer` | Unix timestamp of the last occupancy data update. |
| `cars` | `array` | Individual properties for each railcar. (See **Car Object**). |

### 4a. Car Object (`cars`)
| Property     | Type      | Description                                                              |
| :----------- | :-------- | :----------------------------------------------------------------------- |
| `type`       | `string`  | Specific car class type (e.g., `"M7"`, `"C3"`, `"DEDM"`).                |
| `number`     | `integer` | *(Optional)* Identifying fleet number of the car.                        |
| `loading`    | `string`  | Load state of the specific car (`"EMPTY"`, `"MANY_SEATS"`, `"NO_DATA"`). |
| `passengers` | `integer` | *(Optional)* Estimated raw passenger count inside the car.               |
| `restroom`   | `boolean` | `true` if this car is equipped with a restroom.                          |
| `revenue`    | `boolean` | `true` if it accepts passengers (false for diesel locomotives).          |
| `bikes`      | `integer` | *(Optional)* Supported or detected bicycle count.                        |
| `locomotive` | `boolean` | `true` if the unit is a locomotive.                                      |

---

## 5. Location Object (`location`)
Current geographical telemetry for the train.

| Property     | Type      | Description                                                                                                 |
| :----------- | :-------- | :---------------------------------------------------------------------------------------------------------- |
| `latitude`   | `number`  | GPS Latitude.                                                                                               |
| `longitude`  | `number`  | GPS Longitude.                                                                                              |
| `source`     | `string`  | Origin of the telemetry data (`"GPS"`, `"SIGNAL"`, `"OPER"`).                                               |
| `timestamp`  | `integer` | Unix timestamp when the location was recorded.                                                              |
| `speed`      | `number`  | *(Optional)* Current speed of the train (in mph).                                                           |
| `heading`    | `number`  | *(Optional)* Directional heading in degrees.                                                                |
| `nearby`     | `string`  | *(Optional)* Closest infrastructure tag (e.g., interlocking, tower, or station code like `"HOL"`, `"NA3"`). |
| `extra_info` | `string`  | *(Optional)* Debug or raw system info (e.g., `"hdop: 0.9"` or track circuit `"TK-C46T EXIT"`).              |

---

## 6. Status Object (`status`)
Real-time schedule variance and operating conditions.

| Property       | Type      | Description                                                                                       |
| :------------- | :-------- | :------------------------------------------------------------------------------------------------ |
| `otp`          | `integer` | On-time performance variance in seconds.                                                          |
| `otp_location` | `string`  | The interlocking or station point where the OTP variance was calculated (e.g., `"SYT"`, `"BWN"`). |
| `held`         | `boolean` | `true` if the train is currently being held at a station/signal by dispatch.                      |
| `canceled`     | `boolean` | `true` if the train has been canceled.                                                            |

---

## 7. Alert Object (`alerts`)
*(Optional array)* Includes localized service changes, accessibility notices, or delays.

| Property         | Type      | Description                                                                       |
| :--------------- | :-------- | :-------------------------------------------------------------------------------- |
| `railroad`       | `string`  | The affected agency (e.g., `"LIRR"`).                                             |
| `status`         | `string`  | High-level status text (e.g., `"Saturday Schedule"`, `"Boarding Change"`).        |
| `header`         | `string`  | HTML formatted string for the alert's title/header.                               |
| `text`           | `string`  | HTML formatted string providing the full context of the alert.                    |
| `priority`       | `integer` | Importance ranking used for front-end sorting.                                    |
| `start_time`     | `integer` | Unix timestamp marking when the alert becomes active.                             |
| `human_duration` | `string`  | Human-readable duration string (e.g., `"Sunday, May 24"`, `"Until Summer 2026"`). |
| `status_level`   | `integer` | Internal severity or classification code.                                         |
| `is_planned`     | `boolean` | `true` for planned work/service changes; `false` for ad-hoc issues.               |
| `branches`       | `array`   | List of branch codes impacted by the alert (e.g., `["MK"]`, `["CI"]`).            |

# System Status API Documentation

**Endpoint:** `GET https://backend-unified.mylirr.org/status`

## Overview
This endpoint returns the real-time operational status for all rail branches across the MTA's commuter rail network. Notably, despite the `mylirr.org` domain, this unified endpoint provides system status and service alerts for **both** the Long Island Rail Road (LIRR) and Metro-North Railroad (MNR).

---

## 1. Root Object
The root response is a JSON object containing global system banners and a breakdown of individual branch statuses.

| Property | Type | Description |
| :--- | :--- | :--- |
| `banners` | `array` | A list of system-wide global alerts or banners (often empty `[]` when no global alerts are active). |
| `status` | `array` | A comprehensive list of branch statuses. (See **Branch Status Object**). |

---

## 2. Branch Status Object (`status`)
Represents the current operating conditions for a specific commuter rail branch.

| Property | Type | Description |
| :--- | :--- | :--- |
| `branch` | `string` | The human-readable name of the branch (e.g., `"Babylon"`, `"Harlem"`, `"Montauk"`). |
| `branch_id` | `string` | The internal shorthand code for the branch (e.g., `"BY"`, `"HA"`, `"MK"`). |
| `railroad` | `string` | The operating agency for the branch (`"LIRR"` for Long Island Rail Road, `"MNR"` for Metro-North Railroad). |
| `status` | `string` | A high-level textual summary of the branch's condition (e.g., `"On or Close"`, `"Some Delays"`, `"Saturday Schedule"`, `"Special Schedule"`). |
| `status_level` | `integer` | A numeric severity indicator representing the condition (e.g., `0` for Good Service, `1` or `2` for Schedule Modifications/Planned Work, `3` for Unplanned Delays). |
| `alerts` | `array` | A list of specific alerts currently active for this branch. (See **Alert Object**). |

---

## 3. Alert Object (`alerts`)
Provides granular details about disruptions, service changes, or delays affecting the parent branch.

| Property         | Type      | Description                                                                                                                                  |
| :--------------- | :-------- | :------------------------------------------------------------------------------------------------------------------------------------------- |
| `railroad`       | `string`  | The affected agency (`"LIRR"` or `"MNR"`).                                                                                                   |
| `status`         | `string`  | The specific category of the alert (e.g., `"Some Delays"`, `"Saturday Schedule"`).                                                           |
| `header`         | `string`  | An HTML-formatted string containing the alert's title or main summary.                                                                       |
| `text`           | `string`  | *(Optional)* An HTML-formatted string providing the full descriptive body of the alert. (Usually omitted for short, ad-hoc delay alerts).    |
| `priority`       | `integer` | An importance ranking used by client applications for front-end sorting and display (e.g., `7`, `11`, `24`).                                 |
| `start_time`     | `integer` | Unix timestamp marking when the alert was published or became active.                                                                        |
| `human_duration` | `string`  | *(Optional)* A human-readable timeframe for the alert (e.g., `"Sunday, May 24"`, `"Weekend, May 23 - 24"`).                                  |
| `status_level`   | `integer` | The severity level of this specific alert (aligns with the branch's `status_level`).                                                         |
| `is_planned`     | `boolean` | `true` for scheduled track maintenance or planned timetable changes; `false` for ad-hoc disruptions (e.g., downed trees, equipment trouble). |
| `branches`       | `array`   | A list of strings representing the branch IDs affected by this alert (e.g., `["HA"]`, `["OB"]`).                                             |

# LIRR Station Countdown API Documentation

**Endpoint:** `GET https://backend-unified.mylirr.org/countdown/{station}`

## Overview
This endpoint retrieves a real-time "countdown" list of trains scheduled to arrive at or depart from a specific station within a specified time window. 

The response schema is largely identical to the `/locations` endpoint (returning an array of `Train` objects). However, this endpoint specifically filters trains relevant to the requested station and extensively populates the `events` array to provide a granular, operational timeline of each train's route.

---

## 1. Request Parameters

### Path Parameters
| Parameter | Type | Description |
| :--- | :--- | :--- |
| `station` | `string` | The 3-letter abbreviation code for the station (e.g., `"JAM"` for Jamaica, `"NYK"` for Penn Station). |

### Query Parameters
| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `include_passed` | `boolean` | Yes | If `false`, filters out trains that have already completed their stop at the requested station. |
| `hours` | `float` | Yes | The look-ahead time window in hours (e.g., `1.0` returns trains arriving/departing within the next hour). |

---

## 2. Response Structure: `Train` Array

The endpoint returns a JSON array of `Train` objects. Most of the structure (`train_id`, `details.stops`, `consist`, `location`, `status`) identically matches the schema used in the `/locations` endpoint. 

The most significant addition in the `/countdown` endpoint is the populated `events` array located inside the `details` object.

---

## 3. Events Object (`details.events`)

While the `stops` array only lists public-facing passenger stations, the `events` array provides a highly granular, chronological timeline of the train's journey. It includes both passenger stops and internal operational waypoints (such as interlockings, passing stations, or equipment yards).

| Property | Type | Description |
| :--- | :--- | :--- |
| `code` | `string` | The abbreviation code of the station, yard, or interlocking (e.g., `"JAM"`, `"VAL"`, `"WSY"`). |
| `stop_type` | `string` | The operational nature of the event at this location. Common values include: <br>• `"STOP"` (Passenger stop)<br>• `"NONE"` (Pass-through/non-stopping point)<br>• `"EARLY_DEPARTURE_3"` (Drop-off only/early departure rule)<br>• `"EQUIPMENT"` (Non-revenue equipment move/yard)<br>• `"EMPLOYEE"` (Employee-only stop) |
| `sched_time` | `integer` | The scheduled Unix timestamp for this event. |
| `act_arrive` | `integer` | *(Optional)* The actual recorded arrival Unix timestamp. |
| `act_depart` | `integer` | *(Optional)* The actual recorded departure Unix timestamp. |
| `oper_time` | `integer` | *(Optional)* Operational Unix timestamp, representing an adjusted or predicted time calculated by the dispatch system. |
| `sched_track` | `string` | *(Optional)* The originally scheduled track or routing assignment (e.g., `"WM"`, `"G1"`, `"PS"`). |
| `act_track` | `string` | *(Optional)* The actual track the train operated on during the event. |
| `is_manual` | `boolean` | `true` if the event timing or tracking was manually entered/overridden by a dispatcher rather than automatically triggered by track circuits. |

### Example Event (Non-Stopping Interlocking)
```json
{
  "code": "VAL",
  "stop_type": "NONE",
  "sched_time": 1779650220,
  "act_depart": 1779650247,
  "oper_time": 1779650247,
  "sched_track": "S1",
  "act_track": "S1",
  "is_manual": false
}
```

### Example Event (Passenger Stop)
```json
{
  "code": "WHD",
  "stop_type": "STOP",
  "sched_time": 1779649380,
  "act_depart": 1779649370,
  "oper_time": 1779649440,
  "sched_track": "WM",
  "act_track": "WM",
  "is_manual": true
}
```

# LIRR Solari (Departure Board) API Documentation

**Endpoint:** `GET https://backend-unified.mylirr.org/solari/{station}`

## Overview
This endpoint retrieves a simplified, ordered list of upcoming trains for a specific station, specifically formatted to power digital departure signs (often referred to as "Solari boards"). Unlike the broader `/locations` or `/countdown` endpoints, this payload focuses strictly on passenger-facing information: departure times, upcoming station stops, posted track assignments, and scheduled transfers (connections).

---

## 1. Request Parameters

### Path Parameters
| Parameter | Type | Description |
| :--- | :--- | :--- |
| `station` | `string` | The 3-letter abbreviation code for the station (e.g., `"JAM"` for Jamaica). |

---

## 2. Root Object
The root response is a JSON array of `Departure` objects, typically sorted chronologically by the time they arrive at or depart from the requested station.

### Departure Object
| Property | Type | Description |
| :--- | :--- | :--- |
| `time` | `integer` | Unix timestamp of the train's scheduled (or adjusted) departure/arrival at the queried station. |
| `stops` | `array` | A chronological list of strings representing the station codes this train will serve *after* leaving the queried station (e.g., `["WDD", "NYK"]`). |
| `direction` | `string` | Direction of travel (`"E"` for Eastbound, `"W"` for Westbound). |
| `track` | `string` | *(Optional)* The public track assignment for the train (e.g., `"3"`, `"7"`, `"11"`). This field is often omitted if a track has not yet been assigned or posted. |
| `status` | `object` | Contains real-time schedule variance and cancellation status. (See **Status Object**). |
| `train_id` | `string` | Unique identifier for the train's specific run (e.g., `"LIRR_2026-05-24_7755"`). |
| `railroad` | `string` | The operating agency abbreviation (`"LIRR"`). |
| `run_date` | `string` | The scheduled date of the train run (Format: `YYYY-MM-DD`). |
| `train_num` | `string` | The publicly advertised train schedule number (e.g., `"7755"`). |
| `stop_type` | `string` | The nature of the stop at the queried station (e.g., `"STOP"`). |
| `connections`| `array` | A list of official connecting trains the passenger can transfer to. (See **Connection Object**). |

---

## 3. Status Object (`status`)
Provides quick-glance real-time health for the train.

| Property | Type | Description |
| :--- | :--- | :--- |
| `otp` | `integer` | On-time performance variance in seconds. (`0` indicates on time; negative values generally indicate ahead of schedule; positive values indicate delays). |
| `held` | `boolean` | `true` if the train is actively being held at the station or a signal by dispatchers. |
| `canceled` | `boolean` | `true` if this train has been canceled. |

---

## 4. Connection Object (`connections`)
If the train features an official transfer opportunity down the line, this object outlines where the transfer takes place and what subsequent stops the connecting train serves.

| Property              | Type     | Description                                                                                                                |
| :-------------------- | :------- | :------------------------------------------------------------------------------------------------------------------------- |
| `connection_location` | `string` | The station code where the transfer occurs (e.g., `"BTA"` for Babylon, `"HUN"` for Huntington).                            |
| `stops`               | `array`  | A chronological list of station codes served by the connecting train (e.g., `["BSR", "ISP", "GRV", "ODL", "SVL", "PGE"]`). |

# System Health API Documentation

**Endpoint:** `GET https://backend-unified.mylirr.org/health`

## Overview
This endpoint provides real-time health monitoring and data freshness metrics for the various internal subsystems, APIs, and hardware telemetry feeds that power the unified `mylirr.org` backend. 

It is highly useful for client applications or monitors to verify if delayed tracking or missing passenger loading data is due to a specific subsystem failure (e.g., if the M7 loading sensors stop reporting).

---

## 1. Root Object
The root response is a JSON object containing dynamic keys representing specific internal subsystems. Each key maps to a **Health Object**.

### Health Object
Each subsystem returns an identical schema indicating its status:

| Property | Type | Description |
| :--- | :--- | :--- |
| `healthy` | `boolean` | `true` if the subsystem is currently online and reporting normally. `false` if the feed has crashed, timed out, or is returning errors. |
| `age` | `integer` | The time elapsed (in **seconds**) since the last successful heartbeat, data poll, or payload update from this subsystem. Lower values indicate fresh data. |

#### Example
```json
"wmdsM9": {
  "healthy": true,
  "age": 4
}
```

---

## 2. Subsystem Glossary

The keys returned by the endpoint represent a mix of Long Island Rail Road (LIRR), Metro-North Railroad (MNR), and shared infrastructure systems. Based on the naming conventions, they are grouped below:

### Core Infrastructure & Dispatch (LIRR / Shared)
| Key        | Description                                                                     |
| :--------- | :------------------------------------------------------------------------------ |
| `router`   | The core routing and tracking engine calculating train progression.             |
| `solari`   | The subsystem feeding passenger-facing departure boards (Solari signs).         |
| `avps`     | Audio-Visual Paging System (controls automated station signs/announcements).    |
| `t2s`      | Text-to-Speech engine (generates audio for automated announcements).            |
| `railware` | Interacts with the backend train management, schedule, and dispatch software.   |
| `pscc`     | Penn Station Central Control (tracking specifically for the Penn Station zone). |
| `gtfsRt`   | The standard General Transit Feed Specification (GTFS) Realtime processor.      |

### LIRR Fleet Telemetry & Loading
These feeds process live telemetry from the LIRR rolling stock, particularly focusing on the Wireless Maintenance Data System (WMDS) and passenger weight sensors (used to estimate live crowding).

| Key         | Description                                                                                                                                              |
| :---------- | :------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wmdsM7`    | Telemetry/location feed for the M7 electric fleet.                                                                                                       |
| `wmdsM9`    | Telemetry/location feed for the M9 electric fleet.                                                                                                       |
| `loadingM7` | Passenger capacity/weight sensor feed for M7 cars.                                                                                                       |
| `loadingM9` | Passenger capacity/weight sensor feed for M9 cars.                                                                                                       |
| `loadingC3` | Passenger capacity/weight sensor feed for C3 bi-level diesel cars. *(Note: This often has a higher `age` value due to how diesel consists report data).* |

### Metro-North Railroad (MNR) Systems
Because this is a "Unified" backend, it also processes telemetry for MNR, designated by the `mnr` prefix.

| Key | Description |
| :--- | :--- |
| `mnrTms` | MNR Train Management System (Core dispatch/tracking). |
| `mnrT2s` | MNR Text-to-Speech announcement system. |
| `mnrTilt` | MNR tracking/telemetry subsystem. |
| `mnrRouter...` | MNR routing engines segmented by fleet (`M7a`, `M3a`, `M8`, `Coach`). |
| `mnrWmds...` | MNR Wireless Maintenance Data System telemetry for specific fleets (e.g., `M7a`). |
| `mnrLoading...` | MNR passenger weight/capacity feeds segmented by fleet (`M7a`, `M8`, `Coach`). |