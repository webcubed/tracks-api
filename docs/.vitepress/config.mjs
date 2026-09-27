import { defineConfig } from "vitepress";

export default defineConfig({
	lang: "en-US",
	title: "tracks-api",
	description: "API reference for New York City subway, LIRR, and MTA buses.",
	base: "/docs/",
	cleanUrls: true,
	themeConfig: {
		nav: [
			{ text: "Overview", link: "/" },
			{ text: "API Reference", link: "/agencies" },
		],
		sidebar: [
			{
				text: "API Reference",
				items: [
					{ text: "Overview", link: "/" },
					{ text: "Agencies", link: "/agencies" },
					{ text: "Routes", link: "/routes" },
					{ text: "Stops and schedules", link: "/stops" },
					{ text: "Arrivals", link: "/arrivals" },
					{ text: "Vehicles", link: "/vehicles" },
					{ text: "Alerts", link: "/alerts" },
					{ text: "Fares", link: "/fares" },
					{ text: "Journey planning", link: "/journey" },
					{ text: "Errors", link: "/errors" },
				],
			},
		],
		search: { provider: "local" },
	},
});
