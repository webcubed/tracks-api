# AI agents

Every `/v1` route is a plain `GET` that returns JSON. There is no API key, no OAuth flow, and no request signing, so an agent that can make an HTTP request can use the whole API. This page covers that direct path and the optional MCP server for clients that work through tools.

## Direct HTTP

The deployed instance is `https://tracks-api-ol28.onrender.com`. Point an agent at another instance by changing that base.

```sh
curl 'https://tracks-api-ol28.onrender.com/v1/arrivals?stop=127'
curl 'https://tracks-api-ol28.onrender.com/v1/stops?lat=40.7553&lon=-73.9875&radius=500'
```

A successful response is `{ "data": ... }`. A failure is `{ "error": { "code", "message" } }` with a non-2xx status, so an agent can branch on `code` instead of parsing prose (see [Errors](/errors)).

A working loop for most transit questions:

1. Resolve the place: `GET /v1/stops?lat=&lon=&radius=` or `GET /v1/stops?agency=&route=`.
2. Read live data for that stop: `GET /v1/arrivals?stop=`.
3. If the question spans two places, call `GET /v1/journey?from=&to=` rather than chaining arrivals by hand.
4. Add `GET /v1/alerts?agency=&route=` when the answer should mention disruption, and `GET /v1/vehicles?route=` when it is about where a vehicle is.

Keep the responses in mind:

- `GET /v1/routes` returns a full GeoJSON `shape` per route, and the subway network's geometry is measured in megabytes. Ask for route ids and names first, and fetch one route with geometry only when a map needs it.
- Stop lists carry `geometry` as well. `location` is enough for distance and display.
- Realtime data is cached for about 15 seconds upstream of the API, so polling faster than that does not produce new information.

## MCP server

`mcp/server.ts` is a stdio MCP server. It is a thin proxy: no database, no cache, and no transit logic of its own. Every tool call becomes one HTTP request to the same `/v1` routes, which means it adds no hosting, no deploy step, and no memory cost to the API.

```sh
pnpm install
pnpm mcp
```

The server talks to `https://tracks-api-ol28.onrender.com` unless `TRACKS_API_URL` names another instance. This is the configuration for Claude Desktop, Claude Code, Cursor, and other clients that launch stdio servers:

```json
{
	"mcpServers": {
		"tracks": {
			"command": "pnpm",
			"args": ["--dir", "/absolute/path/to/tracks-api", "run", "mcp"],
			"env": { "TRACKS_API_URL": "https://tracks-api-ol28.onrender.com" }
		}
	}
}
```

Claude Code can register it from the shell:

```sh
claude mcp add tracks -- pnpm --dir /absolute/path/to/tracks-api run mcp
```

### Tools

| Tool              | API route                      | What it answers                                                   |
| ----------------- | ------------------------------ | ----------------------------------------------------------------- |
| `list_agencies`   | `GET /v1/agencies`             | Which feeds exist, and their modes.                               |
| `list_routes`     | `GET /v1/routes`               | Route ids, names, and colours in a feed. Geometry omitted.        |
| `get_route`       | `GET /v1/routes/:id`           | One route, with GeoJSON when `includeShape` is true.              |
| `find_stops`      | `GET /v1/stops`                | Stops by feed, route, or radius around a point.                   |
| `get_stop`        | `GET /v1/stops/:id`            | One stop and the routes serving it.                               |
| `get_arrivals`    | `GET /v1/arrivals`             | Live arrivals with delay, occupancy, and vehicle id.              |
| `get_schedule`    | `GET /v1/stops/:id/schedule`   | Timetable departures for a service date.                          |
| `get_departures`  | `GET /v1/stops/:id/departures` | LIRR board with posted track assignments.                         |
| `get_vehicles`    | `GET /v1/vehicles`             | Live vehicles on a route.                                         |
| `search_vehicles` | `GET /v1/vehicles/search`      | A vehicle by train number, fleet number, or run token.            |
| `get_train_run`   | `GET /v1/vehicles/:id/route`   | Every station, yard, and interlocking an LIRR train touches.      |
| `get_alerts`      | `GET /v1/alerts`               | Active alerts with severity and effect.                           |
| `plan_journey`    | `GET /v1/journey`              | Itineraries across subway, LIRR, and bus on the static timetable. |
| `get_fares`       | `GET /v1/fares`                | Curated fares per feed.                                           |

The `/experimental` routes are not exposed as tools. They proxy undocumented MTA services and their payloads can change without notice; call them over HTTP when a task needs them and the shape is handled explicitly.

### What it costs

- No hosting: the server is a child process of the MCP client. Measured idle resident memory is about 22 MB with the TypeScript loader, and it exits when the client closes the session.
- The 14 tool definitions are 10,991 bytes of JSON, roughly 3,000 tokens when a client includes the catalog in a request. That is the recurring cost, paid by the model, not the API.
- The API sees only the calls the agent makes, with the same caching and limits as any other client.

## Agent notes

- Resolve stop ids with `find_stops` before calling `get_arrivals` or `plan_journey`. IDs are strings, including numeric-looking ones such as `127`.
- Stop ids repeat across feeds: `237` is a subway stop and also LIRR Penn Station. Pass `agency` (or `fromAgency` / `toAgency`) to pin the feed when the id is ambiguous.
- Arrivals, vehicles, alerts, and departures are live. `plan_journey` and `get_schedule` read the static timetable and do not know about delays or cancellations. Do not mix a live delay into a planned itinerary unless the answer says so.
- `get_departures` and `get_train_run` read the LIRR tracking system, the only source that names tracks, yards, and interlockings. Other feeds return an empty board.
- Lists are capped by the MCP server: 25 stops, 50 vehicles, 20 alerts, 30 departures, and 3 itineraries by default. Each response reports `count` and `returned` so the agent can tell when it is seeing a subset.
- The public instance runs on a free tier and can take tens of seconds to wake after idle. The MCP server allows 45 seconds per request.
