import * as fs from "fs";
import * as path from "path";
import { DuckDBInstance } from "@duckdb/node-api";

const instance = await DuckDBInstance.create(":memory:");
const connection = await instance.connect();

const rawDir: string = "./gtfs/raw";
const outputDir: string = "./gtfs/output";

const feeds = fs.readdirSync(path.join(rawDir));

for (const feed of feeds) {
	const currentPath = path.join(rawDir, feed);
	const files = fs.readdirSync(currentPath);
	for (const file of files) {
		const fileName = path.parse(file).name;
		await connection.run(`
	COPY (
		SELECT * FROM read_csv_auto('${fileName}', all_varchar=true)
	) TO '${path.join(outputDir, `${feed}_${fileName}.parquet`)}' (FORMAT PARQUET);`);
	}
}
