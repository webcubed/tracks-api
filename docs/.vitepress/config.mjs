import { defineConfig } from "vitepress";

export default defineConfig({
	lang: "en-US",
	title: "tracks-api",
	description: "API reference for New York City subway, LIRR, and MTA buses.",
	base: "/docs/",
	themeConfig: {
		nav: [{ text: "API Reference", link: "/" }],
		sidebar: [
			{
				text: "API Reference",
				items: [
					{ text: "Overview", link: "/" },
					{ text: "Agencies", link: "/#agencies" },
					{ text: "Routes", link: "/#routes" },
					{ text: "Stops and schedules", link: "/#stops" },
					{ text: "Arrivals", link: "/#arrivals" },
					{ text: "Vehicles", link: "/#vehicles" },
					{ text: "Alerts", link: "/#alerts" },
					{ text: "Fares", link: "/#fares" },
					{ text: "Journey planning", link: "/#journey-planning" },
					{ text: "Errors", link: "/#errors" },
				],
			},
		],
		search: { provider: "local" },
	},
});
