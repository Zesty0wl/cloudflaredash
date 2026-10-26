// cloudflaredash: a private dashboard of a Cloudflare account's usage against the Workers Paid
// plan's included allowances.
//
// The page itself (./public) is static assets, which are free and never run this Worker.
// The Worker answers one route, GET /api/usage. Cloudflare Access guards the whole hostname; the
// Worker verifies the Access JWT as well.
// It reads Cloudflare's own GraphQL Analytics API and returns the raw groups; the browser does the
// arithmetic. The result is cached for CACHE_SECONDS, so however many tabs are open, the account sees
// at most one pair of analytics queries per cache period per data centre.

const CACHE_SECONDS = 300;
// "Refresh" can bypass the cache, but never more often than this.
const MIN_REFRESH_SECONDS = 60;
// Names (scripts, databases, namespaces) change rarely; look them up hourly.
const NAMES_CACHE_SECONDS = 3600;
const CACHE_VERSION = "v2";

const API = "https://api.cloudflare.com/client/v4";

const securityHeaders = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...securityHeaders, ...extra },
  });
}

// MARK: - Cloudflare Access
//
// Access (a self-hosted application on this hostname) signs people in before any request, page or
// API, reaches the site, and adds a signed JWT to each request it lets through. The Worker checks
// that JWT too, so a request that somehow skips Access is still refused.

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CERTS_TTL_MS = 3600_000;
const CLOCK_SKEW_SECONDS = 60;
let certs = { domain: null, keys: new Map(), fetchedAt: 0 };

function base64urlDecode(text) {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

// The team's signing keys, by key ID. Access rotates them, so an unknown kid triggers one refetch.
async function accessKey(teamDomain, kid) {
  const stale = certs.domain !== teamDomain || Date.now() - certs.fetchedAt > CERTS_TTL_MS;
  if (stale || (!certs.keys.has(kid) && Date.now() - certs.fetchedAt > 60_000)) {
    const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
    if (!response.ok) throw new Error(`Access certs: HTTP ${response.status}`);
    const { keys = [] } = await response.json();
    const imported = await Promise.all(
      keys.filter((k) => k.kty === "RSA" && k.kid).map(async (k) => [
        k.kid,
        await crypto.subtle.importKey("jwk", k, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]),
      ]),
    );
    certs = { domain: teamDomain, keys: new Map(imported), fetchedAt: Date.now() };
  }
  return certs.keys.get(kid) ?? null;
}

// ALLOWED_EMAILS (a secret): comma-separated addresses, or "@example.com" for everyone at a domain.
export function parseAllowList(value) {
  return String(value ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
}

export function isAllowed(email, allowList) {
  const address = String(email ?? "").trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at < 1) return false;
  return allowList.includes(address) || allowList.includes(address.slice(at));
}

// Returns the token's claims, or null. Every failure looks the same to the caller.
export async function verifyAccessJWT(token, { teamDomain, audience, allowedEmails, getKey = accessKey, now = Math.floor(Date.now() / 1000) }) {
  if (!teamDomain || !audience || typeof token !== "string" || token.length > 8192) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(decoder.decode(base64urlDecode(parts[0])));
    if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
    const key = await getKey(teamDomain, header.kid);
    if (!key) return null;
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64urlDecode(parts[2]), encoder.encode(`${parts[0]}.${parts[1]}`));
    if (!valid) return null;
    const claims = JSON.parse(decoder.decode(base64urlDecode(parts[1])));
    if (claims.iss !== `https://${teamDomain}`) return null;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(audience)) return null;
    if (!Number.isFinite(claims.exp) || claims.exp <= now - CLOCK_SKEW_SECONDS) return null;
    if (Number.isFinite(claims.nbf) && claims.nbf > now + CLOCK_SKEW_SECONDS) return null;
    // Fail closed: with no allow-list configured, nobody gets in.
    if (!allowedEmails?.length || !isAllowed(claims.email, allowedEmails)) return null;
    return claims;
  } catch {
    return null;
  }
}

function accessToken(request) {
  const header = request.headers.get("cf-access-jwt-assertion");
  if (header) return header;
  const cookie = request.headers.get("cookie") ?? "";
  return cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1] ?? "";
}

// MARK: - Billing period

// The Workers Paid subscription renews on BILLING_ANCHOR_DAY of each month (UTC). Months shorter
// than the anchor day renew on their last day.
export function billingPeriod(now, anchorDay) {
  const at = (year, month) => {
    const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, month, Math.min(anchorDay, days)));
  };
  let start = at(now.getUTCFullYear(), now.getUTCMonth());
  if (start > now) start = at(now.getUTCFullYear(), now.getUTCMonth() - 1);
  const end = at(start.getUTCFullYear(), start.getUTCMonth() + 1);
  const prevStart = at(start.getUTCFullYear(), start.getUTCMonth() - 1);
  // The same point in the previous period, for like-for-like comparisons.
  const prevNow = new Date(Math.min(prevStart.getTime() + (now - start), start.getTime()));
  return { start, end, prevStart, prevNow };
}

// MARK: - Cloudflare API

const WORKERS_QUERY = `
query Workers($account: String!, $start: Time!, $now: Time!, $since48h: Time!, $since24h: Time!, $prevStart: Time!, $prevNow: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    daily: workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $start, datetime_lt: $now }) {
      sum { requests errors subrequests cpuTimeUs responseBodySize clientDisconnects }
      dimensions { date scriptName }
    }
    status: workersInvocationsAdaptive(limit: 2000, filter: { datetime_geq: $start, datetime_lt: $now }) {
      sum { requests }
      dimensions { scriptName status }
    }
    hourly: workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $since48h, datetime_lt: $now }) {
      sum { requests errors cpuTimeUs }
      dimensions { datetimeHour scriptName }
    }
    latency: workersInvocationsAdaptive(limit: 1000, filter: { datetime_geq: $since24h, datetime_lt: $now }) {
      sum { requests }
      quantiles { cpuTimeP50 cpuTimeP99 wallTimeP50 wallTimeP99 }
      dimensions { scriptName }
    }
    previous: workersInvocationsAdaptive(limit: 1000, filter: { datetime_geq: $prevStart, datetime_lt: $prevNow }) {
      sum { requests cpuTimeUs }
      dimensions { scriptName }
    }
    pages: pagesFunctionsInvocationsAdaptiveGroups(limit: 2000, filter: { datetime_geq: $start, datetime_lt: $now }) {
      sum { requests errors }
      dimensions { date scriptName }
    }
    assets: workersAssetsRequestsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $start, datetime_lt: $now }) {
      sum { requests }
      dimensions { date hostname }
    }
  } }
}`;

const PRODUCTS_QUERY = `
query Products($account: String!, $start: Time!, $now: Time!, $since3h: Time!, $startDate: Date!, $today: Date!, $yesterday: Date!, $since30d: Date!) {
  viewer { accounts(filter: { accountTag: $account }) {
    kv: kvOperationsAdaptiveGroups(limit: 10000, filter: { date_geq: $startDate, date_leq: $today }) {
      sum { requests }
      dimensions { date actionType namespaceId }
    }
    kvStorage: kvStorageAdaptiveGroups(limit: 1000, filter: { date_geq: $yesterday, date_leq: $today }) {
      max { byteCount keyCount }
      dimensions { date namespaceId }
    }
    d1: d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date_geq: $startDate, date_leq: $today }) {
      sum { rowsRead rowsWritten readQueries writeQueries }
      dimensions { date databaseId }
    }
    d1Storage: d1StorageAdaptiveGroups(limit: 2000, filter: { date_geq: $since30d, date_leq: $today }) {
      max { databaseSizeBytes }
      dimensions { date databaseId }
    }
    doRequests: durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: { date_geq: $startDate, date_leq: $today }) {
      sum { requests errors }
      dimensions { date namespaceId scriptName }
    }
    doUsage: durableObjectsPeriodicGroups(limit: 10000, filter: { date_geq: $startDate, date_leq: $today }) {
      sum { duration cpuTime rowsRead rowsWritten storageReadUnits storageWriteUnits storageDeletes }
      dimensions { date namespaceId }
    }
    doSqlStorage: durableObjectsSqlStorageGroups(limit: 1000, filter: { date_geq: $yesterday, date_leq: $today }) {
      max { storedBytes }
      dimensions { date namespaceId }
    }
    doKvStorage: durableObjectsStorageGroups(limit: 100, filter: { date_geq: $yesterday, date_leq: $today }) {
      max { storedBytes }
      dimensions { date }
    }
    r2: r2OperationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $start, datetime_lt: $now }) {
      sum { requests responseObjectSize }
      dimensions { date actionType bucketName storageClass }
    }
    r2Storage: r2StorageAdaptiveGroups(limit: 2000, filter: { datetime_geq: $since3h, datetime_lt: $now }) {
      max { payloadSize metadataSize objectCount }
      dimensions { datetime bucketName storageClass }
    }
    r2History: r2StorageAdaptiveGroups(limit: 5000, filter: { date_geq: $since30d, date_leq: $today }) {
      max { payloadSize metadataSize objectCount }
      dimensions { date bucketName storageClass }
    }
    ai: aiInferenceAdaptiveGroups(limit: 1000, filter: { date_geq: $startDate, date_leq: $today }) {
      sum { totalNeurons }
      count
      dimensions { date }
    }
    queues: queueMessageOperationsAdaptiveGroups(limit: 10000, filter: { date_geq: $startDate, date_leq: $today }) {
      sum { billableOperations }
      dimensions { date queueId }
    }
  } }
}`;

async function cfFetch(env, path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json", ...init.headers },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) throw new Error(`${path.split("?")[0]}: HTTP ${response.status}`);
  return body;
}

// A failed query reports its error and the dashboard shows what it has.
async function graphql(env, name, query, variables) {
  try {
    const body = await cfFetch(env, "/graphql", { method: "POST", body: JSON.stringify({ query, variables }) });
    const errors = (body.errors ?? []).map((e) => `${name}: ${e.message}`);
    return { data: body.data?.viewer?.accounts?.[0] ?? null, errors };
  } catch (error) {
    return { data: null, errors: [`${name}: ${error.message}`] };
  }
}

async function names(env) {
  const account = `/accounts/${env.ACCOUNT_ID}`;
  const lists = {
    scripts: [`${account}/workers/scripts`, (r) => ({ id: r.id, modified: r.modified_on })],
    d1: [`${account}/d1/database?per_page=100`, (r) => ({ id: r.uuid, name: r.name })],
    durableObjects: [`${account}/workers/durable_objects/namespaces?per_page=100`, (r) => ({ id: r.id, name: r.name, script: r.script, className: r.class })],
    kv: [`${account}/storage/kv/namespaces?per_page=100`, (r) => ({ id: r.id, name: r.title })],
    queues: [`${account}/queues?per_page=100`, (r) => ({ id: r.queue_id, name: r.queue_name })],
  };
  const entries = await Promise.all(
    Object.entries(lists).map(async ([key, [path, pick]]) => {
      try {
        const body = await cfFetch(env, path);
        return [key, (body.result ?? []).map(pick), null];
      } catch (error) {
        return [key, [], `${key} names: ${error.message}`];
      }
    }),
  );
  const found = Object.fromEntries(entries.map(([key, list]) => [key, list]));
  const errors = entries.map(([, , error]) => error).filter(Boolean);
  // What each Worker is bound to, so storage and operations can be traced back to a project.
  const bindings = await Promise.all(found.scripts.map(async ({ id }) => {
    try {
      const body = await cfFetch(env, `${account}/workers/scripts/${encodeURIComponent(id)}/settings`);
      return [id, (body.result?.bindings ?? []).map(resourceOf).filter(Boolean)];
    } catch (error) {
      errors.push(`${id} bindings: ${error.message}`);
      return [id, []];
    }
  }));
  found.bindings = Object.fromEntries(bindings);
  return { names: found, errors };
}

// The storage-holding resource a binding points at, if any.
function resourceOf(b) {
  switch (b.type) {
    case "r2_bucket": return { kind: "r2", id: b.bucket_name };
    case "d1": return { kind: "d1", id: b.database_id ?? b.id };
    case "kv_namespace": return { kind: "kv", id: b.namespace_id };
    case "durable_object_namespace": return b.namespace_id ? { kind: "do", id: b.namespace_id } : null;
    case "queue": return { kind: "queue", id: b.queue_name };
    default: return null;
  }
}

async function cached(cache, key, maxAgeSeconds, build) {
  const hit = await cache.match(key);
  if (hit) return { body: await hit.json(), hit };
  const body = await build();
  return { body, hit: null, store: () => cache.put(key, new Response(JSON.stringify(body), { headers: { "cache-control": `max-age=${maxAgeSeconds}` } })) };
}

async function usage(env, now) {
  const anchorDay = Number.parseInt(env.BILLING_ANCHOR_DAY ?? "1", 10) || 1;
  const period = billingPeriod(now, anchorDay);
  const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  const day = (d) => d.toISOString().slice(0, 10);
  const hoursAgo = (h) => new Date(now.getTime() - h * 3600_000);

  const [workers, products] = await Promise.all([
    graphql(env, "workers", WORKERS_QUERY, {
      account: env.ACCOUNT_ID,
      start: iso(period.start),
      now: iso(now),
      since48h: iso(hoursAgo(48)),
      since24h: iso(hoursAgo(24)),
      prevStart: iso(period.prevStart),
      prevNow: iso(period.prevNow),
    }),
    graphql(env, "products", PRODUCTS_QUERY, {
      account: env.ACCOUNT_ID,
      start: iso(period.start),
      now: iso(now),
      since3h: iso(hoursAgo(3)),
      startDate: day(period.start),
      today: day(now),
      yesterday: day(hoursAgo(24)),
      since30d: day(hoursAgo(30 * 24)),
    }),
  ]);

  return {
    generatedAt: iso(now),
    period: { start: iso(period.start), end: iso(period.end), prevStart: iso(period.prevStart), prevNow: iso(period.prevNow) },
    workers: workers.data,
    products: products.data,
    errors: [...workers.errors, ...products.errors],
  };
}

async function handleUsage(request, env, ctx) {
  const url = new URL(request.url);
  const cache = caches.default;
  const base = `https://${url.host}/__cache/${CACHE_VERSION}`;
  const usageKey = new Request(`${base}/usage`);
  const namesKey = new Request(`${base}/names`);

  let refresh = url.searchParams.get("refresh") === "1";
  if (refresh) {
    const hit = await cache.match(usageKey);
    const generatedAt = hit ? Date.parse((await hit.json()).generatedAt) : 0;
    refresh = Date.now() - generatedAt >= MIN_REFRESH_SECONDS * 1000;
    if (refresh) await cache.delete(usageKey);
  }

  const now = new Date();
  // Analytics land a minute or two late; asking up to the current second only adds noise.
  now.setUTCSeconds(0, 0);
  const [usageResult, namesResult] = await Promise.all([
    cached(cache, usageKey, CACHE_SECONDS, () => usage(env, now)),
    cached(cache, namesKey, NAMES_CACHE_SECONDS, () => names(env)),
  ]);
  // Never cache a failed read; the next request tries again.
  if (usageResult.store && usageResult.body.workers) ctx.waitUntil(usageResult.store());
  if (namesResult.store && namesResult.body.errors.length === 0) ctx.waitUntil(namesResult.store());

  const body = { ...usageResult.body, names: namesResult.body.names, errors: [...usageResult.body.errors, ...namesResult.body.errors] };
  return json(body, 200, { "x-cache": usageResult.hit ? "hit" : "miss" });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname !== "/api/usage") return json({ error: "not_found" }, 404);
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, { allow: "GET" });

    // Local development only: wrangler dev has no Access in front of it. .dev.vars is never deployed.
    const local = env.DEV_SKIP_ACCESS === "true" && ["localhost", "127.0.0.1"].includes(url.hostname);
    const allowedEmails = parseAllowList(env.ALLOWED_EMAILS);

    // Names only, never values: a half-configured deployment should say what it is missing.
    // (wrangler.example.jsonc's placeholders start with YOUR_.)
    const missing = [
      ["ACCOUNT_ID", env.ACCOUNT_ID],
      ["CF_API_TOKEN", env.CF_API_TOKEN],
      ...(local ? [] : [["ACCESS_TEAM_DOMAIN", env.ACCESS_TEAM_DOMAIN], ["ACCESS_AUD", env.ACCESS_AUD], ["ALLOWED_EMAILS", allowedEmails.length]]),
    ].filter(([, value]) => !value || String(value).startsWith("YOUR_")).map(([name]) => name);
    if (missing.length) return json({ error: "not_configured", missing }, 500);

    const claims = local || (await verifyAccessJWT(accessToken(request), {
      teamDomain: env.ACCESS_TEAM_DOMAIN,
      audience: env.ACCESS_AUD,
      allowedEmails,
    }));
    if (!claims) return json({ error: "unauthorized" }, 401);

    return handleUsage(request, env, ctx);
  },
};
