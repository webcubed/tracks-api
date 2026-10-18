import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { fetchRailSections } from "@/services/sections";

export async function updateRailSections(
	output = process.argv[2] ?? "rail-sections.json"
): Promise<number> {
	const data = await fetchRailSections();
	if (data.length === 0)
		throw new Error("Refusing to publish an empty rail sections snapshot");

	await writeFile(
		output,
		`${JSON.stringify(
			{
				data,
				attribution: "© OpenStreetMap contributors",
				source: "openstreetmap-overpass",
				generatedAt: new Date().toISOString(),
			},
			null,
			2
		)}\n`
	);

	console.info(`Wrote ${data.length} named LIRR track sections to ${output}`);
	return data.length;
}

/** Can be imported by a test without starting the local HTTP test server. */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
	await updateRailSections();
