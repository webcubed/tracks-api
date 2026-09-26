import type { DuckDBConnection } from "@duckdb/node-api";
import { DuckDBInstance } from "@duckdb/node-api";

// Memoize the promise, not the value: concurrent callers share one instance.
let connection: Promise<DuckDBConnection> | undefined;

export async function getDb(): Promise<DuckDBConnection> {
	connection ??= open();
	// Don't let a failed init poison the handle forever.
	connection.catch(() => {
		connection = undefined;
	});
	return connection;
}

async function open(): Promise<DuckDBConnection> {
	console.log("init'ing db");
	const instance = await DuckDBInstance.create(":memory:");
	const db = await instance.connect();
	await db.run("INSTALL httpfs");
	await db.run("LOAD httpfs");
	await db.run("INSTALL json");
	await db.run("LOAD json");
	console.log("db up");
	return db;
}
