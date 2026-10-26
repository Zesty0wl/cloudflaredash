// Manage who can see the dashboard, in both places that decide it: the Cloudflare Access policy
// (which signs people in) and the Worker's ALLOWED_EMAILS secret (which checks them again).
// The Access policy is the source of truth; every change is copied to the secret.
//
//   npm run setup-access -- you@example.com
//                                          put the deployed Worker behind Access (its workers.dev
//                                          URL, previews and any custom domain), let these people
//                                          in, and write the Access settings into wrangler.jsonc
//   npm run admins                         list who has access
//   npm run admins -- add you@example.com  add an address (or "@example.com" for a whole domain)
//   npm run admins -- remove you@example.com
//   npm run admins -- sync                 copy the policy to the secret again
//
// Needs CLOUDFLARE_API_TOKEN: an account API token with "Access: Apps and Policies: Edit" and
// "Workers Scripts: Edit". Reads the account, Worker name and Access AUD from wrangler.jsonc.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const API = "https://api.cloudflare.com/client/v4";

// MARK: - Config

// JSONC: drop comments and trailing commas, leaving strings (which may contain "//") alone.
export function parseJSONC(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1 || text.length;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const WRANGLER = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
const placeholder = (value) => !value || /^YOUR_/.test(value) || value.startsWith("YOUR_TEAM");

function config({ needAud = true } = {}) {
  let wrangler;
  try {
    wrangler = parseJSONC(readFileSync(WRANGLER, "utf8"));
  } catch (error) {
    fail(`Couldn't read wrangler.jsonc (${error.message}). Copy wrangler.example.jsonc to wrangler.jsonc and fill it in first.`);
  }
  const account = wrangler.account_id ?? wrangler.vars?.ACCOUNT_ID;
  const aud = wrangler.vars?.ACCESS_AUD;
  if (placeholder(account) || !wrangler.name) fail("wrangler.jsonc needs name and account_id.");
  if (needAud && placeholder(aud)) fail("wrangler.jsonc has no vars.ACCESS_AUD yet. Run `npm run setup-access -- you@example.com` first.");
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) fail('Set CLOUDFLARE_API_TOKEN to a token with "Access: Apps and Policies: Edit", "Access: Organizations, Identity Providers, and Groups: Edit" and "Workers Scripts: Edit".');
  return { account, aud, script: wrangler.name, token };
}

// Rewrites one string var in wrangler.jsonc in place, keeping its comments and layout.
export function setVar(text, name, value) {
  const pattern = new RegExp(`("${name}"\\s*:\\s*)"[^"]*"`);
  if (!pattern.test(text)) throw new Error(`wrangler.jsonc has no "${name}" var to fill in.`);
  return text.replace(pattern, `$1${JSON.stringify(value)}`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

// MARK: - Policy rules

export function normalise(entry) {
  const value = String(entry ?? "").trim().toLowerCase();
  if (/^@[^@\s]+\.[^@\s]+$/.test(value) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return value;
  return null;
}

export function ruleFor(entry) {
  return entry.startsWith("@") ? { email_domain: { domain: entry.slice(1) } } : { email: { email: entry } };
}

export function entryOf(rule) {
  if (rule.email?.email) return rule.email.email.toLowerCase();
  if (rule.email_domain?.domain) return `@${rule.email_domain.domain.toLowerCase()}`;
  return null;
}

// What the Worker's allow-list should hold for these policies, and any include rules it can't
// mirror (groups, IP ranges, "everyone"): people let in only by those are refused by the Worker.
export function allowListFrom(policies) {
  const entries = new Set();
  const unmirrored = [];
  for (const policy of policies) {
    if (policy.decision !== "allow") continue;
    for (const rule of policy.include ?? []) {
      const entry = entryOf(rule);
      if (entry) entries.add(entry);
      else unmirrored.push(`${policy.name}: ${Object.keys(rule).join(", ")}`);
    }
  }
  return { entries: [...entries].sort(), unmirrored };
}

// MARK: - Cloudflare API

async function cf(cfg, method, path, body, { optional = false } = {}) {
  const response = await fetch(`${API}/accounts/${cfg.account}${path}`, {
    method,
    headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
    body: body && JSON.stringify(body),
  });
  const result = await response.json().catch(() => null);
  if (optional && response.status === 404) return null;
  if (!response.ok || !result?.success) {
    const why = result?.errors?.map((e) => e.message).join("; ") || `HTTP ${response.status}`;
    fail(`${method} ${path.split("?")[0]}: ${why}`);
  }
  return result.result;
}

async function accessApp(cfg) {
  const apps = await cf(cfg, "GET", "/access/apps");
  const app = apps.find((a) => a.aud === cfg.aud);
  if (!app) fail(`No Access application has the AUD in wrangler.jsonc (vars.ACCESS_AUD).`);
  const policies = (app.policies ?? []).toSorted((a, b) => (a.precedence ?? 0) - (b.precedence ?? 0));
  return { app, policies };
}

// The fields a policy update sends back; the rest are read-only.
const READ_ONLY = ["id", "uid", "created_at", "updated_at", "reusable", "app_count"];

// A PUT replaces the whole policy, so start from the full stored copy, not the app's summary of it.
async function savePolicy(cfg, app, policy, include) {
  const path = policy.reusable ? `/access/policies/${policy.id}` : `/access/apps/${app.id}/policies/${policy.id}`;
  const stored = await cf(cfg, "GET", path);
  const body = Object.fromEntries(Object.entries(stored).filter(([key]) => !READ_ONLY.includes(key)));
  if (policy.reusable) delete body.precedence;
  return cf(cfg, "PUT", path, { ...body, include });
}

async function syncSecret(cfg, policies) {
  const { entries, unmirrored } = allowListFrom(policies);
  for (const rule of unmirrored) console.warn(`Note: the Worker can't mirror "${rule}"; people let in only by that rule will be refused.`);
  if (!entries.length) fail("The Access policy lists no email addresses or domains, so the Worker would refuse everyone. Nothing changed.");
  await cf(cfg, "PUT", `/workers/scripts/${encodeURIComponent(cfg.script)}/secrets`, { name: "ALLOWED_EMAILS", text: entries.join(","), type: "secret_text" });
  console.log(`ALLOWED_EMAILS on ${cfg.script} now lists ${entries.length}: ${entries.join(", ")}`);
}

// MARK: - Setup

async function setup(entries) {
  const cfg = config({ needAud: false });

  const org = await cf(cfg, "GET", "/access/organizations", undefined, { optional: true });
  if (!org?.auth_domain) fail("This account has no Zero Trust organisation yet. Open Zero Trust in the Cloudflare dashboard once, choose a team name and the Free plan, then run this again.");

  const scripts = await cf(cfg, "GET", "/workers/scripts");
  const worker = scripts.find((s) => s.id === cfg.script);
  if (!worker?.tag) fail(`There's no Worker called ${cfg.script} yet. Run \`npm run deploy\` first, then this.`);

  // Signing in needs at least one way to prove an address; the one-time code by email needs no setup.
  const idps = await cf(cfg, "GET", "/access/identity_providers");
  if (!idps.length) {
    await cf(cfg, "POST", "/access/identity_providers", { name: "Email one-time code", type: "onetimepin", config: {} });
    console.log("Turned on sign-in with a one-time code by email.");
  }

  const apps = await cf(cfg, "GET", "/access/apps");
  const existing = apps.find((a) => (a.destinations ?? []).some((d) => d.type === "worker" && d.worker_id === worker.tag));
  let app = existing;
  if (app) {
    console.log(`${cfg.script} is already behind Access ("${app.name}"); adding to its policy instead.`);
  } else {
    app = await cf(cfg, "POST", "/access/apps", {
      name: `${cfg.script} (usage dashboard)`,
      type: "self_hosted",
      destinations: [{ type: "worker", worker_id: worker.tag }],
      session_duration: "24h",
      app_launcher_visible: false,
      auto_redirect_to_identity: idps.length <= 1,
      policies: [{ name: `${cfg.script}: admins`, decision: "allow", include: entries.map(ruleFor), precedence: 1 }],
    });
    console.log(`Created Access application "${app.name}": every URL of ${cfg.script} (workers.dev, previews, custom domains) now asks people to sign in.`);
  }

  let text = readFileSync(WRANGLER, "utf8");
  text = setVar(setVar(text, "ACCESS_TEAM_DOMAIN", org.auth_domain), "ACCESS_AUD", app.aud);
  writeFileSync(WRANGLER, text);
  console.log(`Wrote ACCESS_TEAM_DOMAIN (${org.auth_domain}) and ACCESS_AUD to wrangler.jsonc.`);

  if (existing) await change({ ...cfg, aud: app.aud }, "add", entries);
  else await syncSecret(cfg, (await accessApp({ ...cfg, aud: app.aud })).policies);
  console.log("Now run `npm run deploy` so the Worker picks up the Access settings.");
}

// MARK: - Commands

function entriesFrom(args) {
  const entries = args.map(normalise);
  if (!entries.length || entries.includes(null)) fail(`Give one or more email addresses, or "@domain.com" for a whole domain.`);
  return entries;
}

async function main([command = "list", ...args]) {
  if (!["setup", "list", "add", "remove", "sync"].includes(command)) fail("Usage: npm run admins -- [setup <email|@domain>… | list | add <email|@domain>… | remove <email|@domain>… | sync]");
  if (command === "setup") return setup(entriesFrom(args));
  const cfg = config();
  if (command === "add" || command === "remove") return change(cfg, command, entriesFrom(args));
  const { app, policies } = await accessApp(cfg);

  if (command === "list") {
    console.log(`${app.name}${app.domain ? ` (${app.domain})` : ""}`);
    for (const policy of policies) {
      console.log(`  ${policy.decision} · ${policy.name}${policy.reusable ? " (reusable)" : ""}`);
      for (const rule of policy.include ?? []) console.log(`    ${entryOf(rule) ?? JSON.stringify(rule)}`);
    }
    return;
  }

  return syncSecret(cfg, policies);
}

async function change(cfg, command, entries) {
  const { app, policies } = await accessApp(cfg);
  const allow = policies.filter((p) => p.decision === "allow");
  if (!allow.length) fail(`${app.name} has no allow policy to add people to. Create one in Zero Trust > Access first.`);

  const target = allow[0];
  if (allow.length > 1 && command === "add") console.log(`Adding to the first allow policy, "${target.name}".`);
  const changed = [];
  for (const policy of command === "add" ? [target] : allow) {
    const current = (policy.include ?? []).map(entryOf);
    const include = command === "add"
      ? [...policy.include, ...entries.filter((e) => !current.includes(e)).map(ruleFor)]
      : policy.include.filter((rule) => !entries.includes(entryOf(rule)));
    if (include.length === policy.include.length) continue;
    if (!include.length) fail(`Removing ${entries.join(", ")} would leave "${policy.name}" empty. Nothing changed.`);
    Object.assign(policy, await savePolicy(cfg, app, policy, include));
    changed.push(policy.name);
  }
  console.log(changed.length ? `Updated Access policy ${changed.map((n) => `"${n}"`).join(", ")}.` : "The Access policy already says that.");
  await syncSecret(cfg, policies);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
