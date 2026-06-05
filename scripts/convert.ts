import * as fs from "node:fs";
import * as path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";

const instance = await DuckDBInstance.create(":memory:");
const connection = await instance.connect();

const rawDir = "./gtfs/raw";
const outputDir = "./gtfs/output";

const feeds = fs.readdirSync(path.join(rawDir));

const promises = [];
for (const feed of feeds) {
	const currentPath = path.join(rawDir, feed);
	const files = fs.readdirSync(currentPath);
	for (const file of files) {
		const fileName = path.parse(file).name;
		promises.push(
			connection.run(`
	COPY (
		SELECT * FROM read_csv_auto('${path.join(currentPath, fileName)}.txt', all_varchar=true)
	) TO '${path.join(outputDir, `${feed}_${fileName}.parquet`)}' (FORMAT PARQUET);`)
		);
	}
}

await Promise.all(promises);
