/* eslint-disable require-unicode-regexp -- tsconfig targets ES2017, which cannot compile the v flag */

import { createHash, createHmac } from "node:crypto";

/**
 * Backblaze B2 through its S3-compatible API, signed by hand.
 *
 * The archive is three S3 verbs on one bucket (`PUT`, `GET`, `LIST`), which is
 * a few dozen lines of SigV4 rather than another dependency on a 512 MB host.
 * Credentials come from the environment so the recorder and the API share one
 * configuration and neither commits a key.
 */
export type B2Config = {
	/** Origin only, e.g. `https://s3.us-east-005.backblazeb2.com`. */
	endpoint: string;
	region: string;
	keyId: string;
	appKey: string;
	bucket: string;
};

export class B2Error extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = "B2Error";
		this.status = status;
		this.code = code;
	}
}

const CONFIG_KEYS = [
	"B2_ENDPOINT",
	"B2_REGION",
	"B2_KEY_ID",
	"B2_APP_KEY",
	"B2_BUCKET",
] as const;

/** Environment variables the archive needs and that are not set. */
export function missingB2Env(): string[] {
	return CONFIG_KEYS.filter((name) => !process.env[name]);
}

export function b2Config(): B2Config | undefined {
	const missing = missingB2Env();
	if (missing.length > 0) return undefined;

	return {
		endpoint: (process.env.B2_ENDPOINT ?? "").replace(/\/+$/, ""),
		region: process.env.B2_REGION ?? "",
		keyId: process.env.B2_KEY_ID ?? "",
		appKey: process.env.B2_APP_KEY ?? "",
		bucket: process.env.B2_BUCKET ?? "",
	};
}

/** RFC 3986 encoding: SigV4 canonicalizes with `%20`, never `+`. */
function encode(value: string): string {
	return encodeURIComponent(value).replaceAll(
		/[!'()*]/g,
		(character) =>
			`%${(character.codePointAt(0) ?? 0).toString(16).toUpperCase()}`
	);
}

function canonicalPath(bucket: string, key: string): string {
	return `/${bucket}/${key
		.split("/")
		.map((part) => encode(part))
		.join("/")}`;
}

function sha256Hex(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Uint8Array | string, data: string): Uint8Array {
	return createHmac("sha256", key).update(data).digest();
}

/** `20261117T045613Z` and `20261117`, the two date forms SigV4 needs. */
function timestamps(now: Date): { date: string; amzDate: string } {
	const iso = now.toISOString().replaceAll("-", "").replaceAll(":", "");
	return { date: iso.slice(0, 8), amzDate: `${iso.slice(0, 15)}Z` };
}

type SignedRequest = {
	url: string;
	headers: Record<string, string>;
};

type SignInput = {
	method: string;
	key: string;
	query?: Record<string, string>;
	body?: Uint8Array;
	now?: Date;
};

function sign(config: B2Config, input: SignInput): SignedRequest {
	const { body, key, method, now = new Date(), query = {} } = input;
	const url = new URL(`${config.endpoint}${canonicalPath(config.bucket, key)}`);
	const pairs = Object.entries(query).toSorted(([a], [b]) =>
		a.localeCompare(b)
	);
	for (const [name, value] of pairs) url.searchParams.set(name, value);
	const canonicalQuery = pairs
		.map(([name, value]) => `${encode(name)}=${encode(value)}`)
		.join("&");

	const payloadHash = sha256Hex(body ?? "");
	const { date, amzDate } = timestamps(now);
	const { host } = url;
	const canonicalHeaders =
		`host:${host}\n` +
		`x-amz-content-sha256:${payloadHash}\n` +
		`x-amz-date:${amzDate}\n`;
	const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
	const canonicalRequest = [
		method,
		url.pathname,
		canonicalQuery,
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	].join("\n");
	const scope = `${date}/${config.region}/s3/aws4_request`;
	const stringToSign = [
		"AWS4-HMAC-SHA256",
		amzDate,
		scope,
		sha256Hex(canonicalRequest),
	].join("\n");
	const signingKey = hmac(
		hmac(hmac(hmac(`AWS4${config.appKey}`, date), config.region), "s3"),
		"aws4_request"
	);
	const signature = createHmac("sha256", signingKey)
		.update(stringToSign)
		.digest("hex");

	return {
		url: `${url.origin}${url.pathname}${canonicalQuery === "" ? "" : `?${canonicalQuery}`}`,
		headers: {
			Authorization: `AWS4-HMAC-SHA256 Credential=${config.keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
			"x-amz-content-sha256": payloadHash,
			"x-amz-date": amzDate,
			...(body ? { "Content-Length": String(body.byteLength) } : {}),
		},
	};
}

async function failure(response: Response, key: string): Promise<B2Error> {
	const text = await response.text().catch(() => "");
	const code = /<Code>([^<]*)<\/Code>/.exec(text)?.[1] ?? "REQUEST_FAILED";
	const message =
		/<Message>([^<]*)<\/Message>/.exec(text)?.[1] ??
		`${response.status} ${response.statusText} for ${key}`;

	return new B2Error(response.status, code, `${code}: ${message}`);
}

export async function putObject(
	key: string,
	body: Uint8Array,
	contentType = "application/octet-stream"
): Promise<void> {
	const config = requireConfig();
	const request = sign(config, { method: "PUT", key, body });

	await retrying(key, async () =>
		fetch(request.url, {
			method: "PUT",
			headers: { ...request.headers, "Content-Type": contentType },
			// Node accepts a Uint8Array body; the DOM signature only admits the
			// ArrayBuffer-backed generic.
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			body: body as unknown as BodyInit,
			signal: AbortSignal.timeout(60_000),
		})
	);
}

export async function getObject(key: string): Promise<Uint8Array> {
	const config = requireConfig();
	const request = sign(config, { method: "GET", key });
	const response = await retrying(key, async () =>
		fetch(request.url, {
			headers: request.headers,
			signal: AbortSignal.timeout(120_000),
		})
	);

	if (!response.ok) throw await failure(response, key);

	return new Uint8Array(await response.arrayBuffer());
}

function requireConfig(): B2Config {
	const config = b2Config();
	if (!config) {
		throw new B2Error(
			500,
			"ARCHIVE_NOT_CONFIGURED",
			`archive credentials missing: ${missingB2Env().join(", ")}`
		);
	}

	return config;
}

/**
 * B2 answers `500 InternalError` under ordinary load, and a flush that fails
 * has to keep its rows for the next one. Idempotent writes get three tries
 * with backoff; a real client error is raised on the first response.
 */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

async function wait(ms: number): Promise<void> {
	await new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function retrying(
	key: string,
	send: () => Promise<Response>
): Promise<Response> {
	let lastError: unknown;

	for (let attempt = 1; attempt <= 3; attempt += 1) {
		try {
			// eslint-disable-next-line no-await-in-loop -- retries are sequential
			const response = await send();
			if (response.ok) return response;

			// eslint-disable-next-line no-await-in-loop -- one failure read per attempt
			const error = await failure(response, key);
			if (!RETRYABLE.has(error.status)) throw error;
			lastError = error;
		} catch (error) {
			if (error instanceof B2Error && !RETRYABLE.has(error.status)) throw error;
			lastError = error;
		}

		// eslint-disable-next-line no-await-in-loop -- backoff between attempts
		await wait(300 * 2 ** (attempt - 1));
	}

	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export type B2Object = { key: string; size: number };

function decodeXml(value: string): string {
	return value
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		.replaceAll("&amp;", "&");
}

/**
 * Every object under `prefix`, following continuation tokens. Keys are plain
 * ASCII; the sizes are what the disk cache keys on, since objects here are
 * never rewritten.
 */
export async function listObjects(prefix: string): Promise<B2Object[]> {
	const config = requireConfig();

	const objects: B2Object[] = [];
	let continuation: string | undefined;

	do {
		const query: Record<string, string> = {
			"list-type": "2",
			prefix,
			"max-keys": "1000",
		};
		if (continuation) query["continuation-token"] = continuation;

		const request = sign(config, { method: "GET", key: "", query });
		// eslint-disable-next-line no-await-in-loop -- pagination is sequential
		const response = await fetch(request.url, {
			headers: request.headers,
			signal: AbortSignal.timeout(60_000),
		});

		if (!response.ok) {
			// eslint-disable-next-line no-await-in-loop
			throw await failure(response, prefix);
		}

		// eslint-disable-next-line no-await-in-loop
		const xml = await response.text();
		for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
			const body = match[1] ?? "";
			const key = /<Key>([^<]*)<\/Key>/.exec(body)?.[1];
			const size = /<Size>(\d+)<\/Size>/.exec(body)?.[1];
			if (key) objects.push({ key: decodeXml(key), size: Number(size ?? 0) });
		}

		const truncated = xml.includes("<IsTruncated>true</IsTruncated>");
		const token =
			/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1];
		continuation = truncated ? decodeXml(token ?? "") : undefined;
	} while (continuation);

	return objects;
}

/* eslint-enable require-unicode-regexp */
