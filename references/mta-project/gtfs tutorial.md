---
lastSync: Sun Jun 07 2026 21:09:40 GMT-0400 (Eastern Daylight Time)
---
IMPORTANT: Some things you may find online might mention needing an api key for the realtime data found here. This information is outdated as https://api.mta.info no longer requires signing up to access these endpoints. 
just use the gtfs realtime feeds and decode them with protobuf or that one package https://gtfs.org/documentation/realtime/language-bindings/nodejs/#
structure: https://www.mta.info/document/134521
## Static Feeds
### Subway
#### Regular
[Regular GTFS](https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip): This file represents the "normal" subway schedule and does not include most temporary service changes, though some long term service changes may be included. It is typically updated a few times a year.
(source: https://www.mta.info/developers)
#### Supplemental
[Supplemented GTFS](https://rrgtfsfeeds.s3.amazonaws.com/gtfs_supplemented.zip): This file includes most, but not all, service changes for the next seven calendar days. Generally, the 'simpler' the service change, the more likely it will not be included. Beyond that period, service changes will not be included. It is updated **hourly**.
(source: https://www.mta.info/developers)
### Railroads
The railroad GTFS files generally include all schedules for the current timetable, and are updated frequently to include most types of service changes for the next 7-10 days.

- [Long Island Rail Road](https://rrgtfsfeeds.s3.amazonaws.com/gtfslirr.zip)
- [Metro-North Railroad](https://rrgtfsfeeds.s3.amazonaws.com/gtfsmnr.zip)

Schedules for the Port Jervis and Pascack Valley Lines are contained in the [NJ TRANSIT GTFS](https://www.njtransit.com/developer-tools).
### Buses

The bus GTFS is generally updated four times a year to correspond with our quarterly bus schedule changes. Temporary service changes and detours are generally not included.

The data is broken into six separate files, generally by borough with some exceptions:

- [Bronx](https://rrgtfsfeeds.s3.amazonaws.com/gtfs_bx.zip) (includes M100; does not include Bx23 or BxM routes)
- [Brooklyn](https://rrgtfsfeeds.s3.amazonaws.com/gtfs_b.zip) (includes some Queens local routes; does not include B100, B103, BM routes)
- [Manhattan](https://rrgtfsfeeds.s3.amazonaws.com/gtfs_m.zip) (does not include M100)
- [Queens](https://rrgtfsfeeds.s3.amazonaws.com/gtfs_q.zip) (includes most local routes and QM63, QM64, QM68)
- [Staten Island](https://rrgtfsfeeds.s3.amazonaws.com/gtfs_si.zip) (all routes)
- [MTA Bus Company](https://rrgtfsfeeds.s3.amazonaws.com/gtfs_busco.zip) (B100, B103, Bx23, and BxM routes, and various routes in Queens)

Note that these files only contain data for the current quarterly schedule. [Learn more about how to handle the transition between these schedules.](https://new.mta.info/developers/gtfs-schedules-transition)
## Realtime Feeds
format: https://gtfs.org/realtime/
might be useful documentation: https://github.com/nymta/gtfs-documentation
https://www.mta.info/developers also provides protobuf files which are another way to parse the gtfs feeds
line colors might be important: https://www.mta.info/document/168976
### Protobuf files
We need this instead of using https://gtfs.org/documentation/realtime/language-bindings/nodejs/
use https://github.com/protobufjs/protobuf.js for handling gtfs-rs data because it has some extra stuff that the standard gtfs-rt format doesn't include
- Subway: https://raw.githubusercontent.com/OneBusAway/onebusaway-gtfs-realtime-api/master/src/main/proto/com/google/transit/realtime/gtfs-realtime-MTARR.proto
	- reference: https://new.mta.info/document/134521
- LIRR and MNR: https://raw.githubusercontent.com/OneBusAway/onebusaway-gtfs-realtime-api/master/src/main/proto/com/google/transit/realtime/gtfs-realtime-MTARR.proto
- Service Alerts: https://raw.githubusercontent.com/OneBusAway/onebusaway-gtfs-realtime-api/master/src/main/proto/com/google/transit/realtime/gtfs-realtime-service-status.proto
### Subway
- ACE, Rockaway Park shuttle: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace
- BDFM, Franklin Avenue shuttle https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm
- G: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g
- JZ: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz
- NQRW: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw
- L: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l
- IRT & 42nd st shuttle: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs
- SIR: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-si
### LIRR
- https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/lirr%2Fgtfs-lirr
### MNR
- https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/mnr%2Fgtfs-mnr
### Service alerts
documentation: https://www.mta.info/document/168976
example: https://www.mta.info/developers/service-status-box
#### GTFS
- All: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fall-alerts
- Subway: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts
- Bus: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fbus-alerts
- LIRR: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Flirr-alerts
- MNR: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fmnr-alerts
#### JSON
- All: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fall-alerts.json
- Subway: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts.json
- Bus: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fbus-alerts.json
- LIRR: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Flirr-alerts.json
- MNR: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fmnr-alerts.json
### Elevator and Escalator Feeds
#### XML
- Current outages: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fnyct_ene.xml
- Upcoming outages: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fnyct_ene_upcoming.xml
- Equipment: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fnyct_ene_equipments.xml
#### JSON
- Current outages: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fnyct_ene.json
- Upcoming outages: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fnyct_ene_upcoming.json
- Equipment: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fnyct_ene_equipments.json
## How to parse (AI)

```js
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
// 1. Fetch the data from the MTA API
const response = await fetch(feedUrl);
// 2. Read the response as an ArrayBuffer
const buffer = await response.arrayBuffer();
// 3. Decode the Protocol Buffer using the official bindings
// We pass it as a Uint8Array which the decode function requires
const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer))
```
### With protobuf
```js


```
