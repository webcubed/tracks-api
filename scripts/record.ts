import { createRecorder, FLUSH_MS, SAMPLE_MS } from "@/archive/runner";
import { archiveSummary } from "@/archive/store";
import { B2Error, missingB2Env } from "@/lib/b2";

/**
 * The recorder as a process of its own. A host that keeps the API awake can
 * record inside the server instead (`ARCHIVE_RECORD=1`); a host that sleeps
 * would leave a hole in the archive every night, which is why this stays the
 * default.
 *
 *   pnpm record            # sample every ARCHIVE_SAMPLE_MS, flush every ARCHIVE_FLUSH_MS
 *   pnpm record --once     # one sample and one flush, then exit
 *   pnpm record --probe    # what the bucket holds, then exit
 */
const once = process.argv.includes("--once");
const probe = process.argv.includes("--probe");
let stopping = false;

async function main(): Promise<void> {
	if (probe) {
		const coverage = await archiveSummary();
		for (const dataset of coverage)
			console.info(
				`[record] ${dataset.dataset}: ${dataset.parts} parts, ${dataset.bytes} bytes, ${dataset.first ?? "none"} → ${dataset.last ?? "none"}`
			);
		return;
	}

	const missing = missingB2Env();
	if (missing.length > 0) {
		throw new B2Error(
			500,
			"ARCHIVE_NOT_CONFIGURED",
			`set ${missing.join(", ")} in .env`
		);
	}

	console.info(
		`[record] sampling every ${SAMPLE_MS / 1000}s, flushing every ${FLUSH_MS / 1000}s`
	);

	const recorder = createRecorder();

	const stop = async (): Promise<void> => {
		if (stopping) return;
		stopping = true;
		console.info("[record] stopping; flushing");
		await recorder.stop();

		// This is a CLI process, not a request handler: exit once the last flush
		// has landed rather than waiting for the feed clients to go quiet.
		// eslint-disable-next-line unicorn/no-process-exit
		process.exit(0);
	};

	const onSignal = (): void => {
		stop().catch((error: unknown) => {
			console.error("[record] shutdown failed:", error);
		});
	};

	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);

	if (once) {
		await recorder.once();
		// `--once` is a CLI run: DuckDB's native handle keeps the loop alive.
		// eslint-disable-next-line unicorn/no-process-exit
		process.exit(0);
	}

	recorder.start();
}

await main();
