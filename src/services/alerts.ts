import type { AgencyId } from "@/constants";
import type {
	MercuryAlert,
	MercuryEntity,
	MercuryFeed,
	MercuryInformed,
	MercuryText,
} from "@/types/realtime";
import { REALTIME_FEEDS } from "@/constants";
import { memoize } from "@/lib/memoize";
import { FEED_TTL_MS, FeedError, isoNewYork } from "@/services/realtime";
import { getRoute } from "@/services/routes";

export type AlertSeverity = "low" | "medium" | "high" | "critical";
export type AlertEffect =
	| "delays"
	| "detour"
	| "noService"
	| "reducedService"
	| "stopMoved"
	| "alternativeService"
	| "other";

export type ApiAlert = {
	id: string;
	agency: string;
	routes: string[];
	severity: AlertSeverity;
	/** Mercury publishes no cause; this is the GTFS-RT value for "not told". */
	cause: string;
	effect: AlertEffect;
	header: string;
	description?: string;
	activePeriod?: { start?: string; end?: string };
};

/**
 * Mercury's `agency_id` → the feeds that can carry it, verified against all
 * 1806 informed entities on 2026-09-26: MTASBWY routes are all subway, and
 * "MTA NYCT" routes are all borough bus (their static `agency_id` is MTANYCT,
 * shared with subway — the route settles which feed). MTABC is MTA Bus Company
 * = bus_busco. Metro-North has no static feed here, so its alerts drop.
 */
const AGENCY_FEEDS: Record<string, readonly AgencyId[] | undefined> = {
	MTASBWY: ["subway"],
	"MTA NYCT": ["bus_bx", "bus_b", "bus_m", "bus_si", "bus_q"],
	MTABC: ["bus_busco"],
	LI: ["lirr"],
	MNR: undefined,
};

/**
 * `alert_type` is the only classification Mercury publishes — GTFS-RT's
 * `cause`, `effect` and `severity` are never set. Suspended service reads
 * worst, delays and detours next, planned modifications below that, notices
 * and extra service lowest.
 */
const ALERT_TYPES: Record<
	string,
	{ severity: AlertSeverity; effect: AlertEffect }
> = {
	Delays: { severity: "high", effect: "delays" },
	"Expect Delays": { severity: "high", effect: "delays" },
	Detour: { severity: "high", effect: "detour" },
	"Part Suspended": { severity: "critical", effect: "noService" },
	"Planned - Part Suspended": { severity: "high", effect: "noService" },
	"Planned - Suspended": { severity: "high", effect: "noService" },
	"Reduced Service": { severity: "medium", effect: "reducedService" },
	"Special Schedule": { severity: "medium", effect: "reducedService" },
	"Planned - Stops Skipped": { severity: "medium", effect: "reducedService" },
	"Planned - Reroute": { severity: "medium", effect: "detour" },
	"Planned - Express to Local": {
		severity: "medium",
		effect: "alternativeService",
	},
	"Planned - Substitute Buses": {
		severity: "medium",
		effect: "alternativeService",
	},
	"Extra Service": { severity: "low", effect: "alternativeService" },
	"Boarding Change": { severity: "medium", effect: "stopMoved" },
	"Station Notice": { severity: "low", effect: "other" },
	"Special Notice": { severity: "low", effect: "other" },
};

const DEFAULT_KIND = { severity: "medium", effect: "other" } as const;

/** The English translation — feeds also ship an `en-html` variant. */
function text(value: MercuryText | undefined): string {
	const translations = value?.translation ?? [];

	return (
		translations.find((translation) => translation.language === "en")?.text ??
		translations[0]?.text ??
		""
	);
}

function activePeriod(alert: MercuryAlert): ApiAlert["activePeriod"] {
	const period = alert.active_period?.[0];
	if (period?.start === undefined) return undefined;

	return {
		start: isoNewYork(period.start),
		end: period.end === undefined ? undefined : isoNewYork(period.end),
	};
}

/**
 * Which feed an alert belongs to: the first candidate that actually runs its
 * first route. A route with no static data (T403 ran outside GTFS) lands on
 * the group's first feed rather than being dropped.
 */
async function feedForAlert(
	informed: readonly MercuryInformed[]
): Promise<AgencyId | undefined> {
	const first = informed[0];
	const feeds = first?.agency_id ? AGENCY_FEEDS[first.agency_id] : undefined;
	if (!feeds || feeds.length === 0) return undefined;

	const route = first.route_id;
	if (!route) return feeds[0];

	const matches = await Promise.all(
		feeds.map(async (feed) =>
			(await getRoute(feed, route)) ? feed : undefined
		)
	);

	return matches.find((feed) => feed !== undefined) ?? feeds[0];
}

/**
 * One fetch of the shared Mercury feed per TTL window (same window as
 * `fetchFeed`); agency/route filtering happens after, in TypeScript.
 */
const fetchAlerts = memoize(async (): Promise<MercuryEntity[]> => {
	const response = await fetch(REALTIME_FEEDS.ALERTS.JSON.ALL, {
		signal: AbortSignal.timeout(15_000),
	});

	if (!response.ok) {
		throw new FeedError(`alerts feed responded ${response.status}`);
	}

	// Mercury ships no schema; `MercuryFeed` is hand-trimmed from the live
	// JSON, so the assertion can't be checked by the compiler.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	const feed = (await response.json()) as MercuryFeed;

	return feed.entity ?? [];
}, FEED_TTL_MS);

async function toApiAlert(
	entity: MercuryEntity,
	agency?: AgencyId,
	route?: string
): Promise<ApiAlert | undefined> {
	const { alert } = entity;
	if (!entity.id || !alert) return undefined;

	const informed = alert.informed_entity ?? [];
	const routes = [
		...new Set(
			informed
				.map((entry) => entry.route_id)
				.filter((routeId): routeId is string => routeId !== undefined)
		),
	];
	const feed = await feedForAlert(informed);

	if (!feed) return undefined;
	if (agency && feed !== agency) return undefined;
	if (route && !routes.includes(route)) return undefined;

	const kind =
		ALERT_TYPES[alert["transit_realtime.mercury_alert"]?.alert_type ?? ""] ??
		DEFAULT_KIND;
	const description = text(alert.description_text);

	return {
		id: entity.id,
		agency: feed,
		routes,
		severity: kind.severity,
		cause: "unknown",
		effect: kind.effect,
		header: text(alert.header_text),
		description: description === "" ? undefined : description,
		activePeriod: activePeriod(alert),
	};
}

/**
 * Service alerts for every mode, one fetch of the shared Mercury feed.
 * Metro-North alerts are dropped — no static data backs them here.
 */
export async function getAlerts(
	agency?: AgencyId,
	route?: string
): Promise<ApiAlert[]> {
	const entities = await fetchAlerts();
	const alerts = await Promise.all(
		entities.map(async (entity) => toApiAlert(entity, agency, route))
	);

	return alerts.filter((alert): alert is ApiAlert => alert !== undefined);
}
