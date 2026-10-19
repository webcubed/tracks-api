import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * The API serves its VitePress reference from `docs/.vitepress/dist`, which is
 * a gitignored build artifact: a deploy step that only installs dependencies
 * starts the server with no docs on disk and `/docs/` answers 404. Run before
 * the server starts, this builds them on first start whenever they are
 * missing, so the published URL works on any host without special build
 * configuration.
 */
function main() {
	if (existsSync("docs/.vitepress/dist/index.html")) return 0;

	if (!existsSync("node_modules/vitepress/bin/vitepress.js")) {
		console.warn(
			"[docs] docs/.vitepress/dist is missing and vitepress is not installed" +
				" (production-only dependency install?). /docs/ will return 404 until" +
				" `npm run build` runs with devDependencies available."
		);
		return 0;
	}

	console.info(
		"[docs] docs/.vitepress/dist is missing; building the API reference…"
	);

	const result = spawnSync(
		process.execPath,
		["node_modules/vitepress/bin/vitepress.js", "build", "docs"],
		{ stdio: "inherit" }
	);

	// A docs build that fails is a real build error: surface it instead of
	// starting a server that silently serves 404 for its own documentation.
	if (result.status !== 0) return result.status ?? 1;

	if (!existsSync("docs/.vitepress/dist/index.html")) {
		console.error(
			"[docs] vitepress reported success but produced no dist/index.html"
		);
		return 1;
	}

	return 0;
}

process.exitCode = main();
