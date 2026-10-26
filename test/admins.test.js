import { test } from "node:test";
import assert from "node:assert/strict";
import { allowListFrom, normalise, parseJSONC, ruleFor, setVar } from "../scripts/admins.mjs";

test("reads wrangler.jsonc", () => {
  const text = `{
    // a comment
    "url": "https://example.com/path", /* inline */
    "list": [1, 2,],
    "quote": "say \\"hi\\" // not a comment",
  }`;
  assert.deepEqual(parseJSONC(text), { url: "https://example.com/path", list: [1, 2], quote: 'say "hi" // not a comment' });
});

test("normalises addresses and domains", () => {
  assert.equal(normalise(" Admin@Example.com "), "admin@example.com");
  assert.equal(normalise("@Example.com"), "@example.com");
  assert.equal(normalise("example.com"), null);
  assert.equal(normalise("a@b"), null);
  assert.deepEqual(ruleFor("@example.com"), { email_domain: { domain: "example.com" } });
  assert.deepEqual(ruleFor("a@example.com"), { email: { email: "a@example.com" } });
});

test("mirrors allow policies' email and domain rules", () => {
  const { entries, unmirrored } = allowListFrom([
    { name: "admins", decision: "allow", include: [{ email: { email: "B@example.com" } }, { email_domain: { domain: "team.example" } }, { group: { id: "g" } }] },
    { name: "more", decision: "allow", include: [{ email: { email: "a@example.com" } }, { email: { email: "b@example.com" } }] },
    { name: "blocked", decision: "deny", include: [{ email: { email: "c@example.com" } }] },
  ]);
  assert.deepEqual(entries, ["@team.example", "a@example.com", "b@example.com"]);
  assert.deepEqual(unmirrored, ["admins: group"]);
});

test("fills in wrangler.jsonc vars without disturbing comments", () => {
  const text = `{\n  // keep me\n  "vars": {\n    "ACCESS_AUD": "YOUR_ACCESS_APPLICATION_AUD", // and me\n  }\n}`;
  assert.equal(setVar(text, "ACCESS_AUD", "abc"), text.replace("YOUR_ACCESS_APPLICATION_AUD", "abc"));
  assert.throws(() => setVar(text, "MISSING", "x"));
});
