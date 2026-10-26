import { test } from "node:test";
import assert from "node:assert/strict";
import { billingPeriod, isAllowed, parseAllowList, verifyAccessJWT } from "../src/index.js";

const teamDomain = "example.cloudflareaccess.com";
const audience = "test-aud";
const now = 1_800_000_000;
const encode = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const getKey = async (domain, kid) => (domain === teamDomain && kid === "k1" ? publicKey : null);

async function sign(claims = {}, header = {}) {
  const body = `${encode({ alg: "RS256", kid: "k1", ...header })}.${encode({ iss: `https://${teamDomain}`, aud: [audience], email: "admin@example.com", exp: now + 600, ...claims })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(body));
  return `${body}.${Buffer.from(signature).toString("base64url")}`;
}

const options = (allowedEmails = ["admin@example.com"]) => ({ teamDomain, audience, allowedEmails, getKey, now });

test("accepts a valid token from an allowed address", async () => {
  const claims = await verifyAccessJWT(await sign(), options());
  assert.equal(claims?.email, "admin@example.com");
});

test("matches addresses case-insensitively and by domain", async () => {
  assert.ok(await verifyAccessJWT(await sign({ email: "Admin@Example.com" }), options()));
  assert.ok(await verifyAccessJWT(await sign({ email: "someone@example.com" }), options(["@example.com"])));
  assert.equal(await verifyAccessJWT(await sign({ email: "someone@example.com.evil" }), options(["@example.com"])), null);
});

test("refuses everything when the allow-list is empty", async () => {
  assert.equal(await verifyAccessJWT(await sign(), options([])), null);
});

test("refuses addresses not on the list", async () => {
  assert.equal(await verifyAccessJWT(await sign({ email: "other@example.com" }), options()), null);
});

test("refuses the wrong audience, issuer, expiry or algorithm", async () => {
  assert.equal(await verifyAccessJWT(await sign({ aud: ["other"] }), options()), null);
  assert.equal(await verifyAccessJWT(await sign({ iss: "https://other.cloudflareaccess.com" }), options()), null);
  assert.equal(await verifyAccessJWT(await sign({ exp: now - 120 }), options()), null);
  assert.equal(await verifyAccessJWT(await sign({ nbf: now + 120 }), options()), null);
  assert.equal(await verifyAccessJWT(await sign({}, { alg: "none" }), options()), null);
  assert.equal(await verifyAccessJWT(await sign({}, { kid: "unknown" }), options()), null);
});

test("refuses a tampered token", async () => {
  const [header, , signature] = (await sign()).split(".");
  const forged = `${header}.${encode({ iss: `https://${teamDomain}`, aud: [audience], email: "admin@example.com", exp: now + 600, admin: true })}.${signature}`;
  assert.equal(await verifyAccessJWT(forged, options()), null);
  assert.equal(await verifyAccessJWT("not.a.jwt", options()), null);
  assert.equal(await verifyAccessJWT(undefined, options()), null);
});

test("parses the allow-list", () => {
  assert.deepEqual(parseAllowList(" A@x.com, @Y.com ,,"), ["a@x.com", "@y.com"]);
  assert.deepEqual(parseAllowList(undefined), []);
  assert.equal(isAllowed("@x.com", ["@x.com"]), false);
  assert.equal(isAllowed("", ["@x.com"]), false);
});

test("billing periods follow the anchor day", () => {
  const p = billingPeriod(new Date("2026-10-26T12:00:00Z"), 26);
  assert.equal(p.start.toISOString(), "2026-10-26T00:00:00.000Z");
  assert.equal(p.end.toISOString(), "2026-11-26T00:00:00.000Z");
  assert.equal(p.prevStart.toISOString(), "2026-09-26T00:00:00.000Z");
  assert.equal(p.prevNow.toISOString(), "2026-09-26T12:00:00.000Z");

  const before = billingPeriod(new Date("2026-10-25T12:00:00Z"), 26);
  assert.equal(before.start.toISOString(), "2026-09-26T00:00:00.000Z");

  // Short months renew on their last day.
  const february = billingPeriod(new Date("2027-03-01T00:00:00Z"), 31);
  assert.equal(february.start.toISOString(), "2027-02-28T00:00:00.000Z");
  assert.equal(february.end.toISOString(), "2027-03-31T00:00:00.000Z");
});
