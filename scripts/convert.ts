import * as fs from "node:fs";
import * as path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";

const instance = await DuckDBInstance.create(":memory:");
const connection = await instance.connect();

const rawDir = "./gtfs/raw";
const outputDir = "./gtfs/output";

if (!fs.existsSync(outputDir)) {
	fs.mkdirSync(outputDir, { recursive: true });
}

const feeds = fs.readdirSync(path.join(rawDir));
const quote = (value: string) => value.replaceAll("'", "''");

for (const feed of feeds) {
	const currentPath = path.join(rawDir, feed);
	const files = fs.readdirSync(currentPath);
	for (const file of files) {
		const fileName = path.parse(file).name;
		// One COPY at a time keeps memory flat; stop_times is the big one.
		// eslint-disable-next-line no-await-in-loop
		await connection.run(`
	COPY (
		SELECT * FROM read_csv_auto('${quote(path.join(currentPath, fileName))}.txt', all_varchar=true)
	) TO '${quote(path.join(outputDir, `${feed}_${fileName}.parquet`))}' (FORMAT PARQUET);`);
	}

	// Journey scans need two complementary access paths. The compact boarding
	// index is grouped by stop/time; the full timeline is grouped by trip/stop
	// sequence. Building them while raw GTFS is local avoids scanning remote
	// stop_times and joining trips on every route-planning request.
	const stopTimes = path.join(currentPath, "stop_times.txt");
	const trips = path.join(currentPath, "trips.txt");
	const boardIndex = quote(path.join(outputDir, `${feed}_journey_boarding.parquet`));
	const timelineIndex = quote(path.join(outputDir, `${feed}_journey_timeline.parquet`));

	await connection.run(`
	COPY (
		SELECT st.stop_id, st.departure_time, st.trip_id, t.service_id
		FROM read_csv_auto('${quote(stopTimes)}', all_varchar=true) st
		JOIN read_csv_auto('${quote(path.join(currentPath, "trips.txt"))}', all_varchar=true) t
			ON t.trip_id = st.trip_id
		WHERE st.departure_time <> ''
		ORDER BY st.stop_id, st.departure_time
	) TO '${boardIndex}' (FORMAT PARQUET);`);

	await connection.run(`
	COPY (
		SELECT st.trip_id, st.stop_id, st.arrival_time, st.departure_time,
			st.stop_sequence, t.route_id, t.trip_headsign, t.shape_id
		FROM read_csv_auto('${quote(stopTimes)}', all_varchar=true) st
		JOIN read_csv_auto('${quote(path.join(currentPath, "trips.txt"))}', all_varchar=true) t
			ON t.trip_id = st.trip_id
		ORDER BY st.trip_id, CAST(st.stop_sequence AS INTEGER)
	) TO '${timelineIndex}' (FORMAT PARQUET);`);
}
