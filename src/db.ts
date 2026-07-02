import type { DuckDBConnection } from "@duckdb/node-api";
import { DuckDBInstance } from "@duckdb/node-api";

let connection: DuckDBConnection;

export async function getDb() {
	if (connection) return connection;
	console.log("init'ing db");
	const instance = await DuckDBInstance.create(":memory:");
	connection = await instance.connect();
	await connection.run(`
		INSTALL httpfs
		LOAD httpfs
		INSTALL json
		LOAD json
	`);
	console.log("db up");
	return connection;
}
