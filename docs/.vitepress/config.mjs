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
					{ text: "AI agents", link: "/agents" },
					{ text: "Agencies", link: "/agencies" },
					{ text: "Routes", link: "/routes" },
					{ text: "Stops and schedules", link: "/stops" },
					{ text: "Arrivals", link: "/arrivals" },
					{ text: "Vehicles", link: "/vehicles" },
					{ text: "Alerts", link: "/alerts" },
					{ text: "History and analytics", link: "/analytics" },
					{ text: "Fares", link: "/fares" },
					{ text: "Journey planning", link: "/journey" },
					{ text: "Errors", link: "/errors" },
					{ text: "Experimental MTA APIs", link: "/experimental" },
				],
			},
		],
		search: { provider: "local" },
	},
});
