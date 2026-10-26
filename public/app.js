// Cloudflare usage dashboard. /api/usage returns Cloudflare's raw analytics groups; everything
// here turns them into allowance meters, a projected bill, charts and tables.
// Names in the data (scripts, buckets, hostnames) come from the API: they only ever reach the page
// through textContent.

import { ALLOWANCES, BASE_FEE, PRICES_CHECKED, r2Class } from "./pricing.js";

const SERIES = 7; // categorical slots; anything beyond folds into "Other"
const REFRESH_MS = 5 * 60_000;
const $ = (id) => document.getElementById(id);

// MARK: - DOM helpers

function build(node, attrs, children) {
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.setAttribute("class", value);
    else if (key === "style") Object.assign(node.style, value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child != null && child !== false) node.append(child instanceof Node ? child : String(child));
  }
  return node;
}
const h = (tag, attrs = {}, ...children) => build(document.createElement(tag), attrs, children);
const s = (tag, attrs = {}, ...children) => build(document.createElementNS("http://www.w3.org/2000/svg", tag), attrs, children);

// MARK: - Formatting

const integer = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
// en-US compact (K, M, B): en-GB writes millions as "m", which reads as minutes beside "ms".
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const count = (n) => (Math.abs(n) < 10_000 ? integer.format(n) : compact.format(n));
const usd = (n) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: n > 0 && n < 0.01 ? 4 : 2 }).format(n);
const percent = (x) => (x > 0 && x < 0.001 ? "<0.1%" : `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`);

function bytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

// Quantiles arrive in microseconds.
function latency(us) {
  if (us == null) return "–";
  const msValue = us / 1000;
  if (msValue < 10) return `${msValue.toFixed(msValue < 1 ? 2 : 1)} ms`;
  if (msValue < 1000) return `${Math.round(msValue)} ms`;
  return `${(msValue / 1000).toFixed(1)} s`;
}

function amount(value, unit) {
  switch (unit) {
    case "ms": return `${count(value)} ms`;
    case "gbs": return `${count(value)} GB-s`;
    case "bytes": return bytes(value);
    default: return count(value);
  }
}

const utcDay = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const localTime = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
const localHour = new Intl.DateTimeFormat("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" });
const localWeekday = new Intl.DateTimeFormat("en-GB", { weekday: "short" });
const scriptLabel = (x) => (x.name === "__unknown__" ? "Unattributed" : x.kind === "pages" ? `${x.name} (Pages)` : x.name);
const day = (iso) => utcDay.format(new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso));
const isoDay = (date) => date.toISOString().slice(0, 10);

function statusName(status) {
  const names = {
    clientDisconnected: "client disconnected",
    responseStreamDisconnected: "stream disconnected",
    scriptThrewException: "exception",
    exceededResources: "exceeded resources",
    exceededCpu: "exceeded CPU",
    exceededMemory: "exceeded memory",
    internal: "internal error",
  };
  return names[status] ?? status.replace(/([A-Z])/g, " $1").toLowerCase();
}

// MARK: - Model

function sumInto(target, source) {
  for (const [key, value] of Object.entries(source)) target[key] = (target[key] ?? 0) + (value ?? 0);
  return target;
}

// For storage gauges: keep the most recent reading for each key.
function latest(rows = [], keyOf, timeOf) {
  const result = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    const current = result.get(key);
    if (!current || timeOf(row) > timeOf(current)) result.set(key, row);
  }
  return result;
}

function buildModel(data) {
  const now = new Date(data.generatedAt);
  const start = new Date(data.period.start);
  const end = new Date(data.period.end);
  const fraction = Math.min(1, Math.max(1e-6, (now - start) / (end - start)));
  const dayCount = Math.round((end - start) / 86_400_000);
  const dates = Array.from({ length: dayCount }, (_, i) => isoDay(new Date(start.getTime() + i * 86_400_000)));
  const today = isoDay(now);
  const names = data.names ?? {};
  const W = data.workers ?? {};
  const P = data.products ?? {};

  // Workers (and Pages Functions, which bill as Workers requests)
  const scripts = new Map();
  const script = (name, kind = "worker") => {
    const key = kind === "pages" ? `pages:${name}` : name;
    if (!scripts.has(key)) {
      scripts.set(key, {
        key, name, kind, requests: 0, errors: 0, subrequests: 0, cpuUs: 0, bytes: 0, last24h: 0,
        prevRequests: 0, prevCpuUs: 0, daily: new Map(), statuses: new Map(), latency: null,
      });
    }
    return scripts.get(key);
  };
  for (const row of W.daily ?? []) {
    const x = script(row.dimensions.scriptName);
    const { requests, errors, subrequests, cpuTimeUs, responseBodySize } = row.sum;
    sumInto(x, { requests, errors, subrequests, cpuUs: cpuTimeUs, bytes: responseBodySize });
    x.daily.set(row.dimensions.date, sumInto(x.daily.get(row.dimensions.date) ?? {}, { requests, cpuUs: cpuTimeUs }));
  }
  for (const row of W.status ?? []) {
    const x = script(row.dimensions.scriptName);
    x.statuses.set(row.dimensions.status, (x.statuses.get(row.dimensions.status) ?? 0) + row.sum.requests);
  }
  for (const row of W.latency ?? []) script(row.dimensions.scriptName).latency = row.quantiles;
  for (const row of W.previous ?? []) {
    sumInto(script(row.dimensions.scriptName), { prevRequests: row.sum.requests, prevCpuUs: row.sum.cpuTimeUs });
  }
  for (const row of W.pages ?? []) {
    const x = script(row.dimensions.scriptName, "pages");
    sumInto(x, { requests: row.sum.requests, errors: row.sum.errors });
    x.daily.set(row.dimensions.date, sumInto(x.daily.get(row.dimensions.date) ?? {}, { requests: row.sum.requests }));
  }
  // Last 48 hours, hour by hour.
  const hours = new Map();
  const since24h = now.getTime() - 24 * 3_600_000;
  for (const row of W.hourly ?? []) {
    const t = row.dimensions.datetimeHour;
    const hour = hours.get(t) ?? { requests: 0, errors: 0, byScript: new Map() };
    hour.requests += row.sum.requests;
    hour.errors += row.sum.errors;
    hour.byScript.set(row.dimensions.scriptName, row.sum.requests);
    hours.set(t, hour);
    if (Date.parse(t) >= since24h) script(row.dimensions.scriptName).last24h += row.sum.requests;
  }
  // Deployed scripts with no traffic this period still get a row.
  for (const { id } of names.scripts ?? []) script(id);

  const workerRows = [...scripts.values()].sort((a, b) => b.requests - a.requests);
  const totals = workerRows.reduce((t, x) => sumInto(t, {
    requests: x.requests, errors: x.errors, cpuUs: x.cpuUs, prevRequests: x.prevRequests, prevCpuUs: x.prevCpuUs, bytes: x.bytes, subrequests: x.subrequests,
  }), {});

  // Colour follows the script, ranked once by requests, so switching the chart metric never repaints.
  const ranked = workerRows.filter((x) => x.requests > 0);
  ranked.forEach((x, i) => { x.color = i < SERIES ? `var(--series-${i + 1})` : "var(--series-other)"; });

  // Durable Objects
  const doNames = new Map((names.durableObjects ?? []).map((n) => [n.id, n]));
  const namespaces = new Map();
  const ns = (id) => {
    if (!namespaces.has(id)) {
      const meta = doNames.get(id);
      namespaces.set(id, { id, name: meta?.className ?? meta?.name ?? id.slice(0, 8), script: meta?.script ?? "", requests: 0, errors: 0, duration: 0, cpuUs: 0, rowsRead: 0, rowsWritten: 0, readUnits: 0, writeUnits: 0, deletes: 0, sqlBytes: 0 });
    }
    return namespaces.get(id);
  };
  for (const row of P.doRequests ?? []) {
    const x = ns(row.dimensions.namespaceId);
    x.script ||= row.dimensions.scriptName;
    sumInto(x, row.sum);
  }
  for (const row of P.doUsage ?? []) {
    const { duration, cpuTime, rowsRead, rowsWritten, storageReadUnits, storageWriteUnits, storageDeletes } = row.sum;
    sumInto(ns(row.dimensions.namespaceId), { duration, cpuUs: cpuTime, rowsRead, rowsWritten, readUnits: storageReadUnits, writeUnits: storageWriteUnits, deletes: storageDeletes });
  }
  for (const [id, row] of latest(P.doSqlStorage, (r) => r.dimensions.namespaceId, (r) => r.dimensions.date)) ns(id).sqlBytes = row.max.storedBytes;
  const doKvBytes = [...latest(P.doKvStorage, () => "all", (r) => r.dimensions.date).values()][0]?.max.storedBytes ?? 0;
  const doRows = [...namespaces.values()].sort((a, b) => b.requests - a.requests);
  const doTotals = doRows.reduce((t, x) => sumInto(t, { requests: x.requests, duration: x.duration, rowsRead: x.rowsRead, rowsWritten: x.rowsWritten, readUnits: x.readUnits, writeUnits: x.writeUnits, deletes: x.deletes, sqlBytes: x.sqlBytes }), {});

  // D1
  const d1Names = new Map((names.d1 ?? []).map((n) => [n.id, n.name]));
  const databases = new Map();
  const db = (id) => {
    if (!databases.has(id)) databases.set(id, { id, name: d1Names.get(id) ?? id.slice(0, 8), rowsRead: 0, rowsWritten: 0, readQueries: 0, writeQueries: 0, size: 0 });
    return databases.get(id);
  };
  for (const row of P.d1 ?? []) sumInto(db(row.dimensions.databaseId), row.sum);
  for (const [id, row] of latest(P.d1Storage, (r) => r.dimensions.databaseId, (r) => r.dimensions.date)) db(id).size = row.max.databaseSizeBytes;
  for (const { id } of names.d1 ?? []) db(id);
  const d1Rows = [...databases.values()].sort((a, b) => b.rowsRead - a.rowsRead);
  const d1Totals = d1Rows.reduce((t, x) => sumInto(t, { rowsRead: x.rowsRead, rowsWritten: x.rowsWritten, size: x.size }), {});

  // Workers KV
  const kvNames = new Map((names.kv ?? []).map((n) => [n.id, n.name]));
  const kvSpaces = new Map();
  const kv = (id) => {
    if (!kvSpaces.has(id)) kvSpaces.set(id, { id, name: kvNames.get(id) ?? id.slice(0, 8), reads: 0, writes: 0, deletes: 0, lists: 0, bytes: 0, keys: 0 });
    return kvSpaces.get(id);
  };
  for (const row of P.kv ?? []) {
    const action = String(row.dimensions.actionType).toLowerCase();
    const field = action.startsWith("read") ? "reads" : action.startsWith("write") ? "writes" : action.startsWith("delete") ? "deletes" : action.startsWith("list") ? "lists" : null;
    if (field) kv(row.dimensions.namespaceId)[field] += row.sum.requests;
  }
  for (const [id, row] of latest(P.kvStorage, (r) => r.dimensions.namespaceId, (r) => r.dimensions.date)) {
    Object.assign(kv(id), { bytes: row.max.byteCount, keys: row.max.keyCount });
  }
  const kvRows = [...kvSpaces.values()].sort((a, b) => b.reads - a.reads);
  const kvTotals = kvRows.reduce((t, x) => sumInto(t, { reads: x.reads, writes: x.writes, deletes: x.deletes, lists: x.lists, bytes: x.bytes }), {});

  // R2
  const buckets = new Map();
  const bucket = (name) => {
    if (!buckets.has(name)) buckets.set(name, { name, classA: 0, classB: 0, free: 0, iaClassA: 0, iaClassB: 0, standardBytes: 0, iaBytes: 0, objects: 0, served: 0 });
    return buckets.get(name);
  };
  for (const row of P.r2 ?? []) {
    const x = bucket(row.dimensions.bucketName);
    const kind = r2Class(row.dimensions.actionType);
    const ia = row.dimensions.storageClass === "InfrequentAccess";
    x.served += row.sum.responseObjectSize ?? 0;
    if (kind === "free") x.free += row.sum.requests;
    else x[`${ia ? "ia" : ""}${ia ? "Class" : "class"}${kind}`] += row.sum.requests;
  }
  for (const row of latest(P.r2Storage, (r) => `${r.dimensions.bucketName}|${r.dimensions.storageClass}`, (r) => r.dimensions.datetime).values()) {
    const x = bucket(row.dimensions.bucketName);
    const size = (row.max.payloadSize ?? 0) + (row.max.metadataSize ?? 0);
    if (row.dimensions.storageClass === "InfrequentAccess") x.iaBytes += size;
    else x.standardBytes += size;
    x.objects += row.max.objectCount ?? 0;
  }
  const r2Rows = [...buckets.values()].sort((a, b) => b.standardBytes + b.iaBytes - (a.standardBytes + a.iaBytes));
  const r2Totals = r2Rows.reduce((t, x) => sumInto(t, { classA: x.classA, classB: x.classB, iaClassA: x.iaClassA, iaClassB: x.iaClassB, standardBytes: x.standardBytes, iaBytes: x.iaBytes, free: x.free }), {});

  // Which Workers each resource is bound to (from each script's settings).
  const owners = new Map();
  for (const [scriptName, list] of Object.entries(names.bindings ?? {})) {
    for (const r of list) {
      const key = `${r.kind}:${r.id}`;
      if (!owners.has(key)) owners.set(key, []);
      if (!owners.get(key).includes(scriptName)) owners.get(key).push(scriptName);
    }
  }
  const ownersOf = (kind, id) => owners.get(`${kind}:${id}`) ?? [];
  for (const x of r2Rows) x.owners = ownersOf("r2", x.name);
  for (const x of d1Rows) x.owners = ownersOf("d1", x.id);
  for (const x of kvRows) x.owners = ownersOf("kv", x.id);
  for (const x of doRows) x.owners = ownersOf("do", x.id).length ? ownersOf("do", x.id) : x.script ? [x.script] : [];

  // Storage over the last 30 UTC days: each store's largest reading per day.
  const historyDates = Array.from({ length: 30 }, (_, i) => isoDay(new Date(now.getTime() - (29 - i) * 86_400_000)));
  const daily = (rows, keyOf, sizeOf) => {
    const result = new Map();
    for (const row of rows ?? []) {
      const key = keyOf(row);
      if (!result.has(key)) result.set(key, new Map());
      const days = result.get(key);
      days.set(row.dimensions.date, (days.get(row.dimensions.date) ?? 0) + sizeOf(row));
    }
    return result;
  };
  const r2History = daily(P.r2History, (r) => r.dimensions.bucketName, (r) => (r.max.payloadSize ?? 0) + (r.max.metadataSize ?? 0));
  const d1History = daily(P.d1Storage, (r) => r.dimensions.databaseId, (r) => r.max.databaseSizeBytes ?? 0);

  // Every place data is kept, largest first. "bytes" is the newest reading; today's history uses it too.
  const store = (kind, id, name, bytes, owners, history, row) => {
    const days = new Map(history ?? []);
    days.set(today, bytes);
    // The reading `back` days ago, or the earliest one since (a store created or first measured in between).
    const since = (back) => {
      const date = historyDates.slice(29 - back, 29).find((d) => days.has(d));
      return date ? { date, bytes: days.get(date) } : null;
    };
    return { kind, key: `${kind}:${id}`, name, bytes, owners, days, row, week: since(7), month: since(29) };
  };
  const stores = [
    ...r2Rows.map((x) => store("R2", x.name, x.name, x.standardBytes + x.iaBytes, x.owners, r2History.get(x.name), x)),
    ...d1Rows.filter((x) => !names.d1 || names.d1.some((n) => n.id === x.id)).map((x) => store("D1", x.id, x.name, x.size, x.owners, d1History.get(x.id), x)),
    ...kvRows.map((x) => store("KV", x.id, x.name, x.bytes, x.owners, null, x)),
    ...doRows.filter((x) => x.sqlBytes).map((x) => store("Durable Objects", x.id, x.name, x.sqlBytes, x.owners, null, x)),
  ].filter((x) => x.bytes > 0).sort((a, b) => b.bytes - a.bytes);
  stores.forEach((x, i) => { x.color = i < SERIES ? `var(--series-${i + 1})` : "var(--series-other)"; });

  // R2 trend: the last 7 days' change, and where that rate leads.
  const r2Allowance = ALLOWANCES.find((a) => a.id === "r2.storage")?.included ?? 0;
  const r2Stores = stores.filter((x) => x.kind === "R2");
  const r2Trend = {
    now: r2Stores.reduce((sum, x) => sum + x.bytes, 0),
    weekAgo: r2Stores.reduce((sum, x) => sum + (x.week?.bytes ?? 0), 0),
    allowance: r2Allowance,
  };
  // The earliest baseline used: later than a week ago when a bucket only has newer readings.
  r2Trend.since = r2Stores.map((x) => x.week?.date).filter(Boolean).sort()[0] ?? historyDates[22];
  r2Trend.days = Math.max(1, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${r2Trend.since}T00:00:00Z`)) / 86_400_000));
  r2Trend.perDay = (r2Trend.now - r2Trend.weekAgo) / r2Trend.days;

  // Projects: each Worker with the resources bound to it. A shared resource counts in full for each.
  const UNBOUND = ""; // never a script name
  const projects = new Map();
  const project = (name) => {
    if (!projects.has(name)) {
      const deleted = name !== UNBOUND && names.scripts?.length > 0 && !names.scripts.some((x) => x.id === name);
      projects.set(name, { name, unbound: name === UNBOUND, deleted, worker: scripts.get(name), stores: [], activity: new Set(), storage: 0, d1RowsRead: 0, d1RowsWritten: 0, r2Ops: 0, served: 0, kvOps: 0 });
    }
    return projects.get(name);
  };
  for (const st of stores) {
    for (const owner of st.owners.length ? st.owners : [UNBOUND]) {
      const p = project(owner);
      p.stores.push(st);
      p.storage += st.bytes;
    }
  }
  const addOps = (rows, kind, add) => {
    for (const x of rows) {
      for (const owner of x.owners.length ? x.owners : [UNBOUND]) {
        add(project(owner), x);
        project(owner).activity.add(`${kind} ${x.name || "account-level calls"}`);
      }
    }
  };
  addOps(r2Rows.filter((x) => x.classA + x.classB + x.iaClassA + x.iaClassB + x.served > 0), "R2", (p, x) => { p.r2Ops += x.classA + x.classB + x.iaClassA + x.iaClassB; p.served += x.served; });
  addOps(d1Rows.filter((x) => x.rowsRead + x.rowsWritten > 0), "D1", (p, x) => { p.d1RowsRead += x.rowsRead; p.d1RowsWritten += x.rowsWritten; });
  addOps(kvRows.filter((x) => x.reads + x.writes + x.deletes + x.lists > 0), "KV", (p, x) => { p.kvOps += x.reads + x.writes + x.deletes + x.lists; });
  for (const x of workerRows) if (x.kind === "worker" && x.name !== "__unknown__") project(x.name);
  const projectRows = [...projects.values()];

  // Workers AI: the free allocation is per day.
  const neuronsByDay = new Map((P.ai ?? []).map((r) => [r.dimensions.date, r.sum.totalNeurons]));
  const aiAllowance = ALLOWANCES.find((a) => a.id === "ai.neurons");
  const aiOverage = [...neuronsByDay.values()].reduce((sum, n) => sum + Math.max(0, n - aiAllowance.included) * aiAllowance.price, 0);
  const aiPeriod = [...neuronsByDay.values()].reduce((sum, n) => sum + n, 0);

  // Queues
  const queueNames = new Map((names.queues ?? []).map((n) => [n.id, n.name]));
  const queues = new Map();
  for (const row of P.queues ?? []) {
    const id = row.dimensions.queueId;
    const q = queues.get(id) ?? { id, name: queueNames.get(id) ?? id.slice(0, 8), operations: 0 };
    q.operations += row.sum.billableOperations;
    queues.set(id, q);
  }
  const queueRows = [...queues.values()].sort((a, b) => b.operations - a.operations);
  const queueOps = queueRows.reduce((sum, q) => sum + q.operations, 0);

  // Static assets: free and unlimited, but worth seeing.
  const hosts = new Map();
  for (const row of W.assets ?? []) hosts.set(row.dimensions.hostname, (hosts.get(row.dimensions.hostname) ?? 0) + row.sum.requests);
  const assetRows = [...hosts].map(([hostname, requests]) => ({ hostname, requests })).sort((a, b) => b.requests - a.requests);
  const assetTotal = assetRows.reduce((sum, x) => sum + x.requests, 0);

  // Allowances
  const used = {
    "workers.requests": totals.requests ?? 0,
    "workers.cpu": (totals.cpuUs ?? 0) / 1000,
    "do.requests": doTotals.requests ?? 0,
    "do.duration": doTotals.duration ?? 0,
    "do.rowsRead": doTotals.rowsRead ?? 0,
    "do.rowsWritten": doTotals.rowsWritten ?? 0,
    "do.sqlStorage": doTotals.sqlBytes ?? 0,
    "do.kvReads": doTotals.readUnits ?? 0,
    "do.kvWrites": doTotals.writeUnits ?? 0,
    "do.kvDeletes": doTotals.deletes ?? 0,
    "do.kvStorage": doKvBytes,
    "d1.rowsRead": d1Totals.rowsRead ?? 0,
    "d1.rowsWritten": d1Totals.rowsWritten ?? 0,
    "d1.storage": d1Totals.size ?? 0,
    "kv.reads": kvTotals.reads ?? 0,
    "kv.writes": kvTotals.writes ?? 0,
    "kv.deletes": kvTotals.deletes ?? 0,
    "kv.lists": kvTotals.lists ?? 0,
    "kv.storage": kvTotals.bytes ?? 0,
    "r2.classA": r2Totals.classA ?? 0,
    "r2.classB": r2Totals.classB ?? 0,
    "r2.storage": r2Totals.standardBytes ?? 0,
    "r2.iaClassA": r2Totals.iaClassA ?? 0,
    "r2.iaClassB": r2Totals.iaClassB ?? 0,
    "r2.iaStorage": r2Totals.iaBytes ?? 0,
    "queues.operations": queueOps,
    "ai.neurons": neuronsByDay.get(today) ?? 0,
  };

  const allowances = ALLOWANCES.map((a) => {
    const value = used[a.id] ?? 0;
    const projected = a.kind === "usage" ? value / fraction : value;
    const ratio = a.included ? value / a.included : null;
    const projectedRatio = a.included ? projected / a.included : null;
    let cost;
    let projectedCost;
    if (a.kind === "daily") {
      cost = aiOverage;
      projectedCost = aiOverage / fraction;
    } else {
      cost = Math.max(0, value - a.included) * a.price;
      projectedCost = Math.max(0, projected - a.included) * a.price;
    }
    const gauge = projectedRatio ?? 0;
    const level = !a.included ? (value > 0 ? "warning" : "good") : gauge >= 1 ? "critical" : gauge >= 0.75 ? "warning" : "good";
    return { ...a, value, projected, ratio, projectedRatio, cost, projectedCost, level };
  });

  const bill = {
    soFar: BASE_FEE + allowances.reduce((sum, a) => sum + a.cost, 0),
    projected: BASE_FEE + allowances.reduce((sum, a) => sum + a.projectedCost, 0),
    overages: allowances.filter((a) => a.projectedCost >= 0.005).sort((a, b) => b.projectedCost - a.projectedCost),
  };

  // Hourly series for the last 48 hours, with empty hours filled in.
  const lastHour = Math.floor(now.getTime() / 3_600_000) * 3_600_000;
  const hourly = Array.from({ length: 48 }, (_, i) => {
    const t = new Date(lastHour - (47 - i) * 3_600_000);
    const key = t.toISOString().replace(/\.\d{3}Z$/, "Z");
    return { t, ...(hours.get(key) ?? { requests: 0, errors: 0, byScript: new Map() }) };
  });

  return {
    now, start, end, fraction, dates, today, dayCount, dayIndex: Math.min(dayCount, Math.floor((now - start) / 86_400_000) + 1),
    workerRows, totals, doRows, doTotals, d1Rows, kvRows, r2Rows, queueRows, assetRows, assetTotal, aiPeriod,
    stores, historyDates, r2Trend, projectRows,
    allowances, bill, hourly,
  };
}

// MARK: - Tooltip

const tooltip = $("tooltip");

function showTooltip(title, rows, x, y) {
  tooltip.replaceChildren(
    h("div", { class: "title" }, title),
    ...rows.map((r) => h("div", { class: "row" },
      h("i", { class: "key", style: { background: r.color ?? "transparent" } }),
      h("strong", {}, r.value),
      h("span", {}, r.label))),
  );
  tooltip.hidden = false;
  const box = tooltip.getBoundingClientRect();
  const left = Math.min(window.innerWidth - box.width - 8, x + 14);
  const top = y + box.height + 20 > window.innerHeight ? y - box.height - 14 : y + 14;
  tooltip.style.left = `${Math.max(8, left)}px`;
  tooltip.style.top = `${Math.max(8, top)}px`;
}

function hideTooltip() { tooltip.hidden = true; }

// MARK: - Charts

function niceStep(raw) {
  const power = 10 ** Math.floor(Math.log10(raw));
  const f = raw / power;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * power;
}

function yScale(max, ticks = 4) {
  if (!(max > 0)) return { top: 4, step: 1 };
  const step = niceStep(max / ticks);
  return { top: Math.ceil(max / step) * step, step };
}

// Draws a chart at its container's real width (so text stays at its real size), and again whenever
// that width changes. Observers are disconnected when the dashboard is rebuilt.
const observers = [];

function responsive(container, draw) {
  let width = 0;
  const paint = () => container.replaceChildren(draw(width));
  const observer = new ResizeObserver(([entry]) => {
    const w = Math.round(entry.contentRect.width);
    if (w && w !== width) {
      width = w;
      paint();
    }
  });
  observer.observe(container);
  observers.push(observer);
  return { redraw(next) { draw = next; if (width) paint(); } };
}

function yAxis(svg, { top, step }, m, pw, ph, format) {
  const grid = s("g", { class: "grid" });
  for (let v = 0; v <= top + step / 2; v += step) {
    const y = m.t + ph - (v / top) * ph;
    if (v > 0) grid.append(s("line", { x1: m.l, x2: m.l + pw, y1: y, y2: y }));
    grid.append(s("text", { x: m.l - 8, y: y + 4, "text-anchor": "end" }, format(v)));
  }
  svg.append(grid, s("line", { class: "baseline", x1: m.l, x2: m.l + pw, y1: m.t + ph, y2: m.t + ph }));
}

function roundedTop(x, y, w, hgt, r) {
  r = Math.min(r, w / 2, hgt);
  return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
}

function stackedColumns({ dates, lastIndex, series, format, title }) {
  return (width) => {
    const H = 240;
    const m = { t: 10, r: 4, b: 26, l: 48 };
    const pw = width - m.l - m.r;
    const ph = H - m.t - m.b;
    const totals = dates.map((_, i) => series.reduce((sum, x) => sum + (x.values[i] ?? 0), 0));
    const scale = yScale(Math.max(...totals));
    const svg = s("svg", { width, height: H, viewBox: `0 0 ${width} ${H}`, role: "img", "aria-label": title });
    yAxis(svg, scale, m, pw, ph, (v) => format(v, true));

    const band = pw / dates.length;
    const barWidth = Math.max(2, Math.min(24, band * 0.7));
    const labelEvery = Math.max(1, Math.ceil(44 / band));
    const columns = s("g");
    dates.forEach((date, i) => {
      const cx = m.l + band * (i + 0.5);
      if (i % labelEvery === 0) columns.append(s("text", { x: cx, y: H - 8, "text-anchor": "middle" }, day(date)));
      if (i > lastIndex) return;
      const wash = s("rect", { x: m.l + band * i, y: m.t, width: band, height: ph, fill: "var(--wash)", opacity: 0 });
      const col = s("g", {}, wash);
      let y = m.t + ph;
      const segments = series.map((x) => ({ x, v: x.values[i] ?? 0 })).filter((p) => p.v > 0);
      segments.forEach(({ x, v }, j) => {
        const full = (v / scale.top) * ph;
        const isTop = j === segments.length - 1;
        // A 2px surface gap separates stacked segments.
        const drawn = isTop || full <= 3 ? full : full - 2;
        const top = y - full;
        const shape = isTop
          ? s("path", { d: roundedTop(cx - barWidth / 2, top, barWidth, drawn, 4) })
          : s("rect", { x: cx - barWidth / 2, y: y - drawn, width: barWidth, height: drawn });
        shape.style.fill = x.color;
        col.append(shape);
        y = top;
      });
      const describe = () => [
        { value: format(totals[i]), label: "Total" },
        ...segments.slice().reverse().map(({ x, v }) => ({ value: format(v), label: x.name, color: x.color })),
      ];
      const hit = s("rect", { class: "hit", x: m.l + band * i, y: m.t, width: band, height: ph, tabindex: 0, "aria-label": `${day(date)}: ${format(totals[i])}` });
      const on = (event) => {
        wash.setAttribute("opacity", 1);
        const box = hit.getBoundingClientRect();
        showTooltip(day(date), describe(), event.clientX ?? box.right, event.clientY ?? box.top);
      };
      const off = () => { wash.setAttribute("opacity", 0); hideTooltip(); };
      hit.addEventListener("pointermove", on);
      hit.addEventListener("pointerleave", off);
      hit.addEventListener("focus", on);
      hit.addEventListener("blur", off);
      col.append(hit);
      columns.append(col);
    });
    svg.append(columns);
    return svg;
  };
}

function hourlyLine({ points, format, title }) {
  return (width) => {
    const H = 200;
    const m = { t: 12, r: 12, b: 26, l: 48 };
    const pw = width - m.l - m.r;
    const ph = H - m.t - m.b;
    const scale = yScale(Math.max(...points.map((p) => p.requests)));
    const x = (i) => m.l + (i / (points.length - 1)) * pw;
    const y = (v) => m.t + ph - (v / scale.top) * ph;
    const svg = s("svg", { width, height: H, viewBox: `0 0 ${width} ${H}`, role: "img", "aria-label": title });
    yAxis(svg, scale, m, pw, ph, (v) => format(v, true));

    const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.requests).toFixed(1)}`).join("");
    const area = s("path", { d: `${line}L${x(points.length - 1)},${m.t + ph}L${m.l},${m.t + ph}Z`, opacity: 0.1 });
    area.style.fill = "var(--series-1)";
    const path = s("path", { class: "line", d: line });
    path.style.stroke = "var(--series-1)";
    svg.append(area, path);

    const labelEvery = pw / points.length < 14 ? 12 : 6;
    points.forEach((p, i) => {
      if (p.t.getHours() % labelEvery !== 0) return;
      const label = p.t.getHours() === 0 ? localWeekday.format(p.t) : localTime.format(p.t);
      svg.append(s("text", { x: x(i), y: H - 8, "text-anchor": "middle" }, label));
    });

    const last = points.length - 1;
    const endDot = s("circle", { class: "dot", cx: x(last), cy: y(points[last].requests), r: 4 });
    endDot.style.fill = "var(--series-1)";
    const crosshair = s("line", { class: "crosshair", y1: m.t, y2: m.t + ph, opacity: 0 });
    const dot = s("circle", { class: "dot", r: 4, opacity: 0 });
    dot.style.fill = "var(--series-1)";
    const overlay = s("rect", { class: "hit", x: m.l, y: m.t, width: pw, height: ph, tabindex: 0, "aria-label": `${title}. Use the arrow keys to read each hour.` });
    svg.append(endDot, crosshair, dot, overlay);

    let index = last;
    const show = (i, clientX, clientY) => {
      index = Math.max(0, Math.min(last, i));
      const p = points[index];
      crosshair.setAttribute("x1", x(index));
      crosshair.setAttribute("x2", x(index));
      crosshair.setAttribute("opacity", 1);
      dot.setAttribute("cx", x(index));
      dot.setAttribute("cy", y(p.requests));
      dot.setAttribute("opacity", 1);
      const top = [...p.byScript].sort((a, b) => b[1] - a[1]).slice(0, 4);
      showTooltip(localHour.format(p.t), [
        { value: format(p.requests), label: "requests", color: "var(--series-1)" },
        { value: format(p.errors), label: "errors" },
        ...top.map(([name, v]) => ({ value: format(v), label: name })),
      ], clientX, clientY);
    };
    const hide = () => { crosshair.setAttribute("opacity", 0); dot.setAttribute("opacity", 0); hideTooltip(); };
    overlay.addEventListener("pointermove", (event) => {
      const box = overlay.getBoundingClientRect();
      show(Math.round(((event.clientX - box.left) / box.width) * last), event.clientX, event.clientY);
    });
    overlay.addEventListener("pointerleave", hide);
    overlay.addEventListener("blur", hide);
    overlay.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const box = overlay.getBoundingClientRect();
      const next = index + (event.key === "ArrowRight" ? 1 : -1);
      show(next, box.left + (Math.max(0, Math.min(last, next)) / last) * box.width, box.top);
    });
    overlay.addEventListener("focus", () => {
      const box = overlay.getBoundingClientRect();
      show(index, box.right, box.top);
    });
    return svg;
  };
}

function legend(series) {
  return h("ul", { class: "legend" }, series.map((x) => h("li", {}, h("i", { class: "swatch", style: { background: x.color } }), x.name)));
}

// MARK: - Tables

function dataTable({ columns, rows, sortKey, footer, label }) {
  let sort = { key: sortKey, dir: -1 };
  const thead = h("thead");
  const tbody = h("tbody");
  const table = h("table", { "aria-label": label }, thead, tbody);

  const draw = () => {
    const column = columns.find((c) => c.key === sort.key);
    const sorted = rows.slice().sort((a, b) => {
      const av = column.value(a);
      const bv = column.value(b);
      return (typeof av === "string" ? av.localeCompare(bv) : av - bv) * sort.dir;
    });
    thead.replaceChildren(h("tr", {}, columns.map((c) => h("th", {
      scope: "col",
      "aria-sort": c.key === sort.key ? (sort.dir < 0 ? "descending" : "ascending") : null,
    }, h("button", {
      type: "button",
      onclick: () => {
        sort = sort.key === c.key ? { key: c.key, dir: -sort.dir } : { key: c.key, dir: typeof c.value(rows[0] ?? {}) === "string" ? 1 : -1 };
        draw();
      },
    }, c.label)))));
    tbody.replaceChildren(...sorted.map((row) => h("tr", {}, columns.map((c) => {
      const value = c.value(row);
      return h("td", { class: value === 0 ? "zero" : null }, c.render ? c.render(row) : c.format ? c.format(value) : value);
    }))));
  };
  draw();
  if (footer) table.append(h("tfoot", {}, h("tr", {}, footer.map((cell) => h("td", {}, cell)))));
  return h("div", { class: "table-wrap" }, table);
}

function card(title, note, ...content) {
  return h("section", { class: "card" }, h("header", {}, h("h2", {}, title), note ? h("p", {}, note) : null), ...content);
}

// MARK: - Sections

function statusIcon(level) {
  const fill = { good: "var(--good)", warning: "var(--warning)", critical: "var(--critical)" }[level];
  const glyph = {
    good: s("path", { d: "M4 7.2l2 2 4-4.2", fill: "none", stroke: "#fff", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round" }),
    warning: s("path", { d: "M7 4.6v3.2M7 10v.1", stroke: "#0b0b0b", "stroke-width": 1.8, "stroke-linecap": "round" }),
    critical: s("path", { d: "M4.8 4.8l4.4 4.4M9.2 4.8l-4.4 4.4", stroke: "#fff", "stroke-width": 1.8, "stroke-linecap": "round" }),
  }[level];
  const shape = level === "warning"
    ? s("path", { d: "M7 1.2l6 11H1z", fill, "stroke-linejoin": "round" })
    : s("circle", { cx: 7, cy: 7, r: 6.2, fill });
  return s("svg", { width: 14, height: 14, viewBox: "0 0 14 14", "aria-hidden": "true" }, shape, glyph);
}

function delta(current, previous) {
  if (!previous) return current ? "new this period" : "";
  const change = current / previous - 1;
  if (change >= 9) return `${integer.format(current / previous)}×`;
  const sign = change >= 0 ? "+" : "−";
  return `${sign}${Math.abs(change * 100).toFixed(Math.abs(change) < 0.1 ? 1 : 0)}%`;
}

function summarySection(model) {
  const { bill, totals, allowances, end } = model;
  const renews = day(end.toISOString());
  const busiest = allowances
    .filter((a) => a.included && a.value > 0)
    .map((a) => ({ a, ratio: a.kind === "usage" ? a.projectedRatio : a.ratio }))
    .sort((x, y) => y.ratio - x.ratio)[0];
  const overageNote = bill.overages.length
    ? `$${BASE_FEE} base fee plus overage on ${bill.overages.slice(0, 3).map((a) => `${a.product} ${a.label.toLowerCase()} (${usd(a.projectedCost)})`).join(", ")}.`
    : `The $${BASE_FEE} base fee only: everything so far fits the included allowances.`;
  const errorRate = totals.requests ? totals.errors / totals.requests : 0;
  const last24h = model.hourly.slice(24).reduce((sum, p) => sum + p.requests, 0);
  const previous24h = model.hourly.slice(0, 24).reduce((sum, p) => sum + p.requests, 0);

  const tile = (label, value, note, noteClass) => h("div", { class: "card tile" },
    h("div", { class: "label" }, label), h("div", { class: "value" }, value), h("div", { class: `note ${noteClass ?? ""}` }, note));

  return h("section", { class: "summary" },
    h("div", { class: "card hero" },
      h("div", { class: "label" }, `Projected bill for the period ending ${renews}`),
      h("div", { class: "value" }, usd(bill.projected)),
      h("p", { class: "note" }, overageNote, bill.soFar > BASE_FEE ? ` ${usd(bill.soFar)} so far.` : "")),
    busiest
      ? tile("Busiest allowance", percent(busiest.ratio), `${busiest.a.product} ${busiest.a.label.toLowerCase()}, ${busiest.a.kind === "usage" ? `projected by ${renews}` : "now"}`, busiest.ratio >= 1 ? "delta-bad" : null)
      : null,
    tile("Workers requests", count(totals.requests ?? 0), `${delta(totals.requests, totals.prevRequests)} vs this point last period`),
    tile("Workers CPU time", amount((totals.cpuUs ?? 0) / 1000, "ms"), `${delta(totals.cpuUs, totals.prevCpuUs)} vs this point last period`),
    tile("Workers requests, last 24 hours", count(last24h), `${delta(last24h, previous24h) || "–"} vs the 24 hours before`),
    tile("Errors", count(totals.errors ?? 0), `${percent(errorRate)} of requests`, errorRate >= 0.01 ? "delta-bad" : null),
    tile("Static asset requests", count(model.assetTotal), "Free and unlimited; not counted above"),
  );
}

function allowanceSection(model) {
  const renews = day(model.end.toISOString());
  const groups = new Map();
  for (const a of model.allowances) {
    if (!groups.has(a.product)) groups.set(a.product, []);
    groups.get(a.product).push(a);
  }
  const unused = [];
  const content = [];
  for (const [product, items] of groups) {
    const shown = items.filter((a) => a.value > 0 || product === "Workers");
    if (!shown.length) { unused.push(product); continue; }
    content.push(h("div", { class: "allowance-group" }, h("h3", {}, product), shown.map((a) => {
      const meter = h("div", { class: "meter", role: "meter", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(Math.min(1, a.ratio ?? 0) * 100), "aria-label": `${product} ${a.label}` },
        h("div", { class: `fill ${a.level === "good" ? "" : a.level}`, style: { width: `${Math.min(1, a.ratio ?? (a.value > 0 ? 1 : 0)) * 100}%` } }),
        a.kind === "usage" && a.included ? h("div", { class: "projection", title: "Projected by the end of the period", style: { left: `calc(${Math.min(1, a.projectedRatio) * 100}% - 1px)` } }) : null);
      let status;
      if (!a.included) status = `No free tier · ${usd(a.cost)} so far`;
      else if (a.kind === "usage") status = `${{ good: "On track", warning: "Close", critical: "Over" }[a.level]} · ${percent(a.projectedRatio)} by ${renews}${a.projectedCost >= 0.005 ? ` (+${usd(a.projectedCost)})` : ""}`;
      else if (a.kind === "storage") status = `${{ good: "Within allowance", warning: "Close to allowance", critical: "Over allowance" }[a.level]}${a.cost >= 0.005 ? ` · +${usd(a.cost)}/month` : ""}`;
      else status = `${{ good: "Within today's allowance", warning: "Close", critical: "Over today" }[a.level]} · resets 00:00 UTC`;
      return h("div", { class: "allowance" },
        h("div", { class: "name" }, a.label),
        meter,
        h("div", { class: "figures" }, a.included ? `${amount(a.value, a.unit)} of ${amount(a.included, a.unit)} ` : `${amount(a.value, a.unit)} `, a.included ? h("small", {}, percent(a.ratio)) : null),
        h("div", { class: "status" }, statusIcon(a.level), status));
    })));
  }
  if (unused.length) content.push(h("p", { class: "unused" }, `Not used this period: ${unused.join(", ")}.`));
  return card("Included allowances", "Account-wide, Workers Paid plan. The tick marks where each one is heading by the end of the period.", h("div", { class: "allowances" }, content));
}

function workersChartSection(model) {
  const active = model.workerRows.filter((x) => x.requests > 0);
  const top = active.slice(0, SERIES);
  const rest = active.slice(SERIES);
  const lastIndex = model.dayIndex - 1;
  const seriesFor = (metric) => {
    const values = (x) => model.dates.map((d) => (x.daily.get(d)?.[metric] ?? 0) / (metric === "cpuUs" ? 1000 : 1));
    const list = top.map((x) => ({ name: scriptLabel(x), color: x.color, values: values(x) }));
    if (rest.length) {
      list.push({ name: `Other (${rest.length})`, color: "var(--series-other)", values: model.dates.map((_, i) => rest.reduce((sum, x) => sum + values(x)[i], 0)) });
    }
    return list;
  };
  const metrics = {
    requests: { label: "Requests", format: (v, axis) => (axis ? compact.format(v) : count(v)) },
    cpuUs: { label: "CPU time", format: (v, axis) => (axis ? compact.format(v) : amount(v, "ms")) },
  };
  let metric = "requests";
  const chartBox = h("div", { class: "chart" });
  const legendBox = h("div");
  const chartFor = () => {
    const series = seriesFor(metric);
    legendBox.replaceChildren(legend(series));
    return stackedColumns({ dates: model.dates, lastIndex, series, format: metrics[metric].format, title: `Workers ${metrics[metric].label.toLowerCase()} by day` });
  };
  const chart = responsive(chartBox, chartFor());
  const buttons = Object.entries(metrics).map(([key, m]) => h("button", {
    type: "button",
    "aria-pressed": String(key === metric),
    onclick: () => {
      metric = key;
      buttons.forEach((b, i) => b.setAttribute("aria-pressed", String(Object.keys(metrics)[i] === metric)));
      chart.redraw(chartFor());
    },
  }, m.label));
  return card("Workers by day", `UTC days, ${day(model.start.toISOString())} to ${day(new Date(model.end - 1).toISOString())}`,
    h("div", { class: "toggle", role: "group", "aria-label": "Metric" }, buttons), h("div", { style: { height: "10px" } }), legendBox, chartBox);
}

function hourlySection(model) {
  const box = h("div", { class: "chart" });
  responsive(box, hourlyLine({ points: model.hourly, format: (v, axis) => (axis ? compact.format(v) : count(v)), title: "Workers requests per hour, last 48 hours" }));
  return card("Last 48 hours", "Workers requests per hour, all scripts, your local time", box);
}

function workersTableSection(model) {
  const total = model.totals.requests || 1;
  const columns = [
    {
      key: "name", label: "Worker", value: (x) => x.name, render: (x) => {
        const issues = [...x.statuses].filter(([status]) => status !== "success").sort((a, b) => b[1] - a[1]).map(([status, n]) => `${count(n)} ${statusName(status)}`);
        return h("span", {},
          h("span", { class: "name-cell" }, h("i", { class: "swatch", style: { background: x.color ?? "transparent" } }), scriptLabel(x)),
          issues.length ? h("span", { class: "detail" }, issues.join(" · ")) : null);
      },
    },
    { key: "requests", label: "Requests", value: (x) => x.requests, format: count },
    { key: "share", label: "Share", value: (x) => x.requests / total, format: percent },
    { key: "change", label: "vs last period", value: (x) => (x.prevRequests ? x.requests / x.prevRequests : x.requests ? Infinity : 0), render: (x) => delta(x.requests, x.prevRequests) || "–" },
    { key: "last24h", label: "Last 24h", value: (x) => x.last24h, format: count },
    { key: "errors", label: "Errors", value: (x) => x.errors, render: (x) => (x.errors ? `${count(x.errors)} (${percent(x.errors / Math.max(1, x.requests))})` : "0") },
    { key: "cpu", label: "CPU time", value: (x) => x.cpuUs / 1000, format: (v) => amount(v, "ms") },
    { key: "cpuP50", label: "CPU p50", value: (x) => x.latency?.cpuTimeP50 ?? -1, render: (x) => latency(x.latency?.cpuTimeP50) },
    { key: "cpuP99", label: "CPU p99", value: (x) => x.latency?.cpuTimeP99 ?? -1, render: (x) => latency(x.latency?.cpuTimeP99) },
    { key: "wallP50", label: "Wall p50", value: (x) => x.latency?.wallTimeP50 ?? -1, render: (x) => latency(x.latency?.wallTimeP50) },
    { key: "subrequests", label: "Subrequests", value: (x) => x.subrequests, format: count },
    { key: "bytes", label: "Sent", value: (x) => x.bytes, format: bytes },
  ];
  const t = model.totals;
  return card("Workers", "This billing period. Percentiles are for the last 24 hours. Every deployed script is listed, even with no traffic.",
    dataTable({
      columns, rows: model.workerRows, sortKey: "requests", label: "Workers",
      footer: [`${model.workerRows.length} scripts`, count(t.requests ?? 0), "100%", delta(t.requests, t.prevRequests) || "–", "", count(t.errors ?? 0), amount((t.cpuUs ?? 0) / 1000, "ms"), "", "", "", count(t.subrequests ?? 0), bytes(t.bytes ?? 0)],
    }));
}

// Who a resource belongs to, for detail lines.
const usedBy = (owners) => (owners?.length ? `Used by ${owners.join(", ")}` : "Not bound to any Worker");

// A signed change in bytes since a baseline reading, naming its date when that's later than the column's start.
function byteChange(now, base, back, today) {
  if (!base) return "–";
  const change = now - base.bytes;
  const text = Math.abs(change) < 1024 ? "no change" : `${change > 0 ? "+" : "−"}${bytes(Math.abs(change))}`;
  const start = isoDay(new Date(Date.parse(`${today}T00:00:00Z`) - back * 86_400_000));
  return base.date > start ? h("span", {}, text, h("span", { class: "detail" }, `since ${day(base.date)}`)) : text;
}

function projectsSection(model) {
  const columns = [
    {
      key: "name", label: "Project", value: (x) => (x.unbound ? "~" : x.name), render: (x) => h("span", {},
        h("span", { class: "name-cell" }, x.unbound ? "Not bound to any Worker" : x.name),
        x.deleted || x.stores.length || x.unbound ? h("span", { class: "detail" }, [
          x.deleted ? "Deleted (traffic from earlier this period)" : null,
          ...x.stores.map((st) => `${st.kind} ${st.name} (${bytes(st.bytes)})${st.owners.length > 1 ? ", shared" : ""}`),
          // Unbound activity usually means a Worker that has since been deleted, or a resource used from outside Workers.
          ...(x.unbound ? [...x.activity].filter((a) => !x.stores.some((st) => `${st.kind} ${st.name}` === a)).map((a) => `${a} (activity this period)`) : []),
        ].filter(Boolean).join(" · ")) : null),
    },
    { key: "storage", label: "Storage", value: (x) => x.storage, format: bytes },
    { key: "requests", label: "Requests", value: (x) => x.worker?.requests ?? 0, format: count },
    { key: "cpu", label: "CPU time", value: (x) => (x.worker?.cpuUs ?? 0) / 1000, format: (v) => amount(v, "ms") },
    { key: "d1RowsRead", label: "D1 rows read", value: (x) => x.d1RowsRead, format: count },
    { key: "d1RowsWritten", label: "D1 rows written", value: (x) => x.d1RowsWritten, format: count },
    { key: "r2Ops", label: "R2 operations", value: (x) => x.r2Ops, format: count },
    { key: "served", label: "R2 served", value: (x) => x.served, format: bytes },
    { key: "kvOps", label: "KV operations", value: (x) => x.kvOps, format: count },
  ];
  return card("By project", "Each Worker with the storage and databases bound to it, this billing period. A resource bound to several Workers counts in full for each; anything bound to none is listed on its own so leftovers stand out.",
    dataTable({ columns, rows: model.projectRows, sortKey: "storage", label: "Projects" }));
}

function storageSection(model) {
  const { stores, historyDates, r2Trend } = model;
  if (!stores.length) return null;
  const total = stores.reduce((sum, x) => sum + x.bytes, 0);
  const top = stores.slice(0, SERIES);
  const rest = stores.slice(SERIES);

  // Where it is now: one bar, a segment per store.
  const label = (x) => `${x.name} (${x.kind})`;
  const segments = [...top.map((x) => ({ ...x, name: label(x) })), ...(rest.length ? [{ name: `Other (${rest.length})`, bytes: rest.reduce((sum, x) => sum + x.bytes, 0), color: "var(--series-other)" }] : [])];
  const bar = h("div", { class: "share-bar", role: "img", "aria-label": `Storage by store: ${segments.map((x) => `${x.name} ${bytes(x.bytes)}`).join(", ")}` },
    segments.map((x) => h("div", { style: { width: `${(x.bytes / total) * 100}%`, background: x.color }, title: `${x.name}: ${bytes(x.bytes)}` })));
  const key = h("ul", { class: "legend" }, segments.map((x) => h("li", {}, h("i", { class: "swatch", style: { background: x.color } }), `${x.name} · ${bytes(x.bytes)}`)));

  // The last 30 days, stacked by store. Values in GB so the axis gets round numbers.
  const GB = 1024 ** 3;
  const series = [
    ...top.filter((x) => x.days.size > 1).map((x) => ({ name: label(x), color: x.color, values: historyDates.map((d) => (x.days.get(d) ?? 0) / GB) })),
  ];
  const chartBox = h("div", { class: "chart" });
  responsive(chartBox, stackedColumns({ dates: historyDates, lastIndex: historyDates.length - 1, series, format: (v) => bytes(v * GB), title: "Storage by day, last 30 days" }));

  let trend;
  const then = r2Trend.days >= 7 ? "a week ago" : day(r2Trend.since);
  if (Math.abs(r2Trend.perDay) < 1024 ** 2) trend = `R2 holds ${bytes(r2Trend.now)}, about the same as ${then}.`;
  else if (r2Trend.perDay < 0) trend = `R2 holds ${bytes(r2Trend.now)}, down ${bytes(r2Trend.weekAgo - r2Trend.now)} on ${then}.`;
  else {
    const left = r2Trend.allowance - r2Trend.now;
    const days = left > 0 ? Math.floor(left / r2Trend.perDay) : 0;
    trend = `R2 holds ${bytes(r2Trend.now)}, growing about ${bytes(r2Trend.perDay)} a day since ${then}. `
      + (left > 0 ? `At that rate the ${bytes(r2Trend.allowance)} included lasts until about ${day(new Date(model.now.getTime() + days * 86_400_000).toISOString())}.` : `That is past the ${bytes(r2Trend.allowance)} included.`);
  }

  const table = dataTable({
    label: "Storage by store", sortKey: "bytes", rows: stores,
    columns: [
      { key: "name", label: "Store", value: (x) => x.name, render: (x) => h("span", {}, h("span", { class: "name-cell" }, h("i", { class: "swatch", style: { background: x.color } }), x.name), h("span", { class: "detail" }, `${x.kind} · ${usedBy(x.owners)}`)) },
      { key: "bytes", label: "Now", value: (x) => x.bytes, format: bytes },
      { key: "share", label: "Share", value: (x) => x.bytes / total, format: percent },
      { key: "week", label: "7 days", value: (x) => (x.week ? x.bytes - x.week.bytes : -1e18), render: (x) => byteChange(x.bytes, x.week, 7, model.today) },
      { key: "month", label: "30 days", value: (x) => (x.month ? x.bytes - x.month.bytes : -1e18), render: (x) => byteChange(x.bytes, x.month, 29, model.today) },
    ],
    footer: [`${stores.length} stores`, bytes(total), "100%", "", ""],
  });

  return card("Storage", "Everything stored in R2, D1, KV and Durable Objects: where it is now, and the last 30 days (each day's largest reading). Cloudflare's storage readings arrive up to an hour late.",
    h("p", { class: "trend" }, trend), bar, key, chartBox, table);
}

function durableObjectsSection(model) {
  if (!model.doRows.length) return null;
  return card("Durable Objects", "By namespace, this billing period",
    dataTable({
      label: "Durable Objects", sortKey: "requests", rows: model.doRows,
      columns: [
        { key: "name", label: "Namespace", value: (x) => x.name, render: (x) => h("span", {}, x.name, h("span", { class: "detail" }, usedBy(x.owners))) },
        { key: "requests", label: "Requests", value: (x) => x.requests, format: count },
        { key: "errors", label: "Errors", value: (x) => x.errors, format: count },
        { key: "duration", label: "Duration", value: (x) => x.duration, format: (v) => amount(v, "gbs") },
        { key: "cpu", label: "CPU time", value: (x) => x.cpuUs / 1000, format: (v) => amount(v, "ms") },
        { key: "rowsRead", label: "Rows read", value: (x) => x.rowsRead, format: count },
        { key: "rowsWritten", label: "Rows written", value: (x) => x.rowsWritten, format: count },
        { key: "storage", label: "SQLite storage", value: (x) => x.sqlBytes, format: bytes },
      ],
    }));
}

function d1Section(model) {
  if (!model.d1Rows.length) return null;
  return card("D1", "By database, this billing period",
    dataTable({
      label: "D1 databases", sortKey: "rowsRead", rows: model.d1Rows,
      columns: [
        { key: "name", label: "Database", value: (x) => x.name, render: (x) => h("span", {}, x.name, h("span", { class: "detail" }, usedBy(x.owners))) },
        { key: "rowsRead", label: "Rows read", value: (x) => x.rowsRead, format: count },
        { key: "rowsWritten", label: "Rows written", value: (x) => x.rowsWritten, format: count },
        { key: "readQueries", label: "Reads", value: (x) => x.readQueries, format: count },
        { key: "writeQueries", label: "Writes", value: (x) => x.writeQueries, format: count },
        { key: "size", label: "Size", value: (x) => x.size, format: bytes },
      ],
    }));
}

function r2Section(model) {
  if (!model.r2Rows.length) return null;
  return card("R2", "By bucket. Operations this billing period; storage now.",
    dataTable({
      label: "R2 buckets", sortKey: "storage", rows: model.r2Rows,
      columns: [
        { key: "name", label: "Bucket", value: (x) => x.name, render: (x) => h("span", {}, x.name || "Account-level calls (no bucket)", h("span", { class: "detail" }, [usedBy(x.owners), x.iaBytes || x.iaClassA || x.iaClassB ? `Infrequent Access: ${bytes(x.iaBytes)}, ${count(x.iaClassA + x.iaClassB)} ops` : null].filter(Boolean).join(" · "))) },
        { key: "storage", label: "Storage", value: (x) => x.standardBytes + x.iaBytes, format: bytes },
        { key: "objects", label: "Objects", value: (x) => x.objects, format: count },
        { key: "classA", label: "Class A", value: (x) => x.classA + x.iaClassA, format: count },
        { key: "classB", label: "Class B", value: (x) => x.classB + x.iaClassB, format: count },
        { key: "free", label: "Free ops", value: (x) => x.free, format: count },
        { key: "served", label: "Served", value: (x) => x.served, format: bytes },
      ],
    }));
}

function kvSection(model) {
  if (!model.kvRows.length) return null;
  return card("Workers KV", "By namespace. Operations this billing period; storage now.",
    dataTable({
      label: "KV namespaces", sortKey: "reads", rows: model.kvRows,
      columns: [
        { key: "name", label: "Namespace", value: (x) => x.name, render: (x) => h("span", {}, x.name, h("span", { class: "detail" }, usedBy(x.owners))) },
        { key: "reads", label: "Reads", value: (x) => x.reads, format: count },
        { key: "writes", label: "Writes", value: (x) => x.writes, format: count },
        { key: "deletes", label: "Deletes", value: (x) => x.deletes, format: count },
        { key: "lists", label: "Lists", value: (x) => x.lists, format: count },
        { key: "bytes", label: "Storage", value: (x) => x.bytes, format: bytes },
        { key: "keys", label: "Keys", value: (x) => x.keys, format: count },
      ],
    }));
}

function queuesSection(model) {
  if (!model.queueRows.length) return null;
  return card("Queues", "Billable operations this billing period",
    dataTable({
      label: "Queues", sortKey: "operations", rows: model.queueRows,
      columns: [
        { key: "name", label: "Queue", value: (x) => x.name },
        { key: "operations", label: "Operations", value: (x) => x.operations, format: count },
      ],
    }));
}

function assetsSection(model) {
  if (!model.assetRows.length) return null;
  const total = model.assetTotal || 1;
  return card("Static assets", "Requests served from Workers static assets, by hostname. Free and unlimited.",
    dataTable({
      label: "Static asset requests", sortKey: "requests", rows: model.assetRows,
      columns: [
        { key: "hostname", label: "Hostname", value: (x) => x.hostname },
        { key: "requests", label: "Requests", value: (x) => x.requests, format: count },
        { key: "share", label: "Share", value: (x) => x.requests / total, format: percent },
      ],
    }));
}

function notes(model, cacheState) {
  const link = (href, text) => h("a", { href, rel: "noreferrer", target: "_blank" }, text);
  return h("footer", { class: "notes" },
    h("p", {}, "Figures come from Cloudflare's GraphQL Analytics API. They are sampled and arrive a few minutes late, so treat them as close estimates: Cloudflare's invoice is the final word."),
    h("p", {}, `The billing period runs ${day(model.start.toISOString())} to ${day(model.end.toISOString())} (day ${model.dayIndex} of ${model.dayCount}). Projections assume the rest of the period runs at the average rate so far. Storage is shown as it is now; Cloudflare bills its monthly average.`),
    h("p", {}, `Prices checked ${PRICES_CHECKED}: `, link("https://developers.cloudflare.com/workers/platform/pricing/", "Workers"), ", ", link("https://developers.cloudflare.com/r2/pricing/", "R2"), ", ", link("https://developers.cloudflare.com/workers-ai/platform/pricing/", "Workers AI"), ". Workers Logs, Images, Stream and other products are not included."),
    h("p", {}, `Data is fetched at most every 5 minutes and shared by every open tab (${cacheState === "hit" ? "this view came from the cache" : "this view was fetched just now"}).`),
  );
}

// MARK: - Loading

let lastLoaded = 0;
let loading = false;

async function load(refresh = false) {
  if (loading) return;
  loading = true;
  const dashboard = $("dashboard");
  dashboard.classList.add("stale");
  if (dashboard.hidden) $("loading").hidden = false;
  $("refresh").disabled = true;
  try {
    // redirect: "manual" so an expired Access session (a redirect to the sign-in page) is detectable.
    const response = await fetch(`/api/usage${refresh ? "?refresh=1" : ""}`, { credentials: "same-origin", redirect: "manual", headers: { accept: "application/json" } });
    if (response.type === "opaqueredirect" || response.status === 401 || response.status === 403) {
      signedOut();
      return;
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      if (body?.error === "not_configured") throw new Error(`the Worker is missing ${body.missing.join(", ")}. See the README's setup steps.`);
      throw new Error(`The server answered ${response.status}.`);
    }
    const data = await response.json();
    render(data, response.headers.get("x-cache"));
    lastLoaded = Date.now();
  } catch (error) {
    showProblems([`Couldn't load usage: ${error.message}`]);
  } finally {
    loading = false;
    dashboard.classList.remove("stale");
    $("loading").hidden = true;
    $("refresh").disabled = false;
  }
}

function signedOut() {
  $("dashboard").hidden = true;
  $("actions").hidden = true;
  $("signed-out").hidden = false;
}

function showProblems(problems) {
  const box = $("problems");
  box.hidden = !problems.length;
  box.replaceChildren(h("strong", {}, "Some figures are missing"), h("ul", {}, problems.map((p) => h("li", {}, p))));
}

function render(data, cacheState) {
  const model = buildModel(data);
  $("period").textContent = `Workers Paid · ${day(data.period.start)} to ${day(data.period.end)} · day ${model.dayIndex} of ${model.dayCount}`;
  $("updated").textContent = `Updated ${localTime.format(model.now)}`;
  $("actions").hidden = false;
  showProblems(data.errors ?? []);
  hideTooltip();
  observers.splice(0).forEach((o) => o.disconnect());
  const dashboard = $("dashboard");
  dashboard.replaceChildren(
    summarySection(model),
    allowanceSection(model),
    projectsSection(model),
    storageSection(model),
    workersChartSection(model),
    hourlySection(model),
    workersTableSection(model),
    h("div", { class: "two" }, durableObjectsSection(model), d1Section(model)),
    h("div", { class: "two" }, r2Section(model), assetsSection(model)),
    h("div", { class: "two" }, kvSection(model), queuesSection(model)),
    notes(model, cacheState),
  );
  for (const pair of dashboard.querySelectorAll(".two")) if (!pair.children.length) pair.remove();
  dashboard.hidden = false;
}

$("refresh").addEventListener("click", () => load(true));
$("reload").addEventListener("click", () => location.reload());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Date.now() - lastLoaded > REFRESH_MS) load();
});
setInterval(() => { if (document.visibilityState === "visible") load(); }, REFRESH_MS);
load();
