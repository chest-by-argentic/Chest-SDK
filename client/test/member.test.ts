import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, mock, test } from "node:test";
import { member } from "../src/member.js";

// An assertion the Chest's front signed (chest/toolfront.Assertion, Go), for
// the tool « web », at 1790000000, with the instance key 00 01 … 1f: the
// derivation of the key and the encoding are the Chest's, not this test's.
const chestToken = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const signedByChest = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhZG1pbiI6dHJ1ZSwiYXVkIjoid2ViIiwiYnVpbGRlciI6ZmFsc2UsImVtYWlsIjoiYWxpY2VAZXhhbXBsZS50ZXN0IiwiZXhwIjoxNzkwMDAwMDYwLCJmYW1pbHlfbmFtZSI6Ik1hcnRpbiIsImdpdmVuX25hbWUiOiJBbGljZSIsImlhdCI6MTc5MDAwMDAwMCwiaXNzIjoiaHR0cHM6Ly93ZWItY2hlc3QuYXRlbGllci5leGFtcGxlIiwibmFtZSI6IkFsaWNlIE1hcnRpbiIsInBpY3R1cmUiOiJodHRwczovL3dlYi1jaGVzdC5hdGVsaWVyLmV4YW1wbGUvX2NoZXN0L21lbWJlcnMvYWxpY2UvcGhvdG8iLCJyb2xlIjoiZWRpdGV1ciIsInN1YiI6ImFsaWNlIn0.O9r0oOReZLNjzd4SNrH2f8qRSUGIJwyDMNa9D6xZP9I";
const signedAt = 1790000000;
const alice = { id: "alice", firstName: "Alice", lastName: "Martin", name: "Alice Martin", email: "alice@example.test", photo: "https://web-chest.atelier.example/_chest/members/alice/photo", role: "editeur", isAdmin: true, isBuilder: false };

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const keyOf = (token: string): Buffer => createHmac("sha256", Buffer.from(token, "utf8")).update("Chest-Member v1").digest();
// sign builds an assertion as the Chest does, with what a case changes.
function sign(claims: Record<string, unknown> = {}, header: Record<string, unknown> = { alg: "HS256", typ: "JWT" }, token = chestToken): string {
  const now = Math.floor(Date.now() / 1000);
  const body = encode(header) + "." + encode({ iss: "https://web-chest.atelier.example", aud: "web", iat: now, exp: now + 60, sub: "bob", given_name: "Bob", family_name: "", name: "Bob", email: "bob@example.test", picture: "", role: "", admin: false, builder: false, ...claims });
  return body + "." + createHmac("sha256", keyOf(token)).update(body).digest("base64url");
}
const web = (value?: string | string[]): Request => {
  const headers = new Headers();
  for (const item of value === undefined ? [] : [value].flat()) headers.append("Chest-Member", item);
  return new Request("https://web-chest.atelier.example/chest", { headers });
};
const node = (value?: string | string[]): IncomingMessage => {
  const request = new IncomingMessage(new Socket());
  if (value !== undefined) request.headers["chest-member"] = value;
  return request;
};

beforeEach(() => { process.env["CHEST_TOKEN"] = chestToken; process.env["CHEST_TOOL"] = "web"; });
afterEach(() => { mock.timers.reset(); delete process.env["CHEST_TOKEN"]; delete process.env["CHEST_TOOL"]; });

test("an assertion signed by the Chest reads as its member, on a Web Request and on a Node request", () => {
  mock.timers.enable({ apis: ["Date"], now: signedAt * 1000 });
  assert.deepEqual(member(web(signedByChest)), alice);
  assert.deepEqual(member(node(signedByChest)), alice);
  // Within the tolerated skew on both sides, not beyond.
  mock.timers.setTime((signedAt + 64) * 1000);
  assert.deepEqual(member(node(signedByChest)), alice);
  mock.timers.setTime((signedAt + 65) * 1000);
  assert.equal(member(node(signedByChest)), null);
  mock.timers.setTime((signedAt - 5) * 1000);
  assert.deepEqual(member(node(signedByChest)), alice);
  mock.timers.setTime((signedAt - 6) * 1000);
  assert.equal(member(node(signedByChest)), null);
});

test("photo and role are absent when the Chest names none", () => {
  assert.deepEqual(member(web(sign())), { id: "bob", firstName: "Bob", lastName: "", name: "Bob", email: "bob@example.test", isAdmin: false, isBuilder: false });
  assert.deepEqual(member(node(sign({ role: "lecteur", builder: true }))), { id: "bob", firstName: "Bob", lastName: "", name: "Bob", email: "bob@example.test", role: "lecteur", isAdmin: false, isBuilder: true });
});

test("no assertion, or one that is not exactly a Chest-Member, is null — never an error", () => {
  const now = Math.floor(Date.now() / 1000);
  const [header = "", payload = "", signature = ""] = sign().split(".");
  const cases: Record<string, string | string[] | undefined> = {
    absent: undefined,
    empty: "",
    garbage: "not a token",
    "wrong key": sign({}, undefined, "B".repeat(43)),
    "alg none": encode({ alg: "none", typ: "JWT" }) + "." + payload + ".",
    "alg HS512": sign({}, { alg: "HS512", typ: "JWT" }),
    "typ missing": sign({}, { alg: "HS256" }),
    "typ other": sign({}, { alg: "HS256", typ: "at+jwt" }),
    "extra header": sign({}, { alg: "HS256", typ: "JWT", crit: ["exp"] }),
    expired: sign({ iat: now - 120, exp: now - 60 }),
    "issued in the future": sign({ iat: now + 30, exp: now + 90 }),
    "exp before iat": sign({ iat: now, exp: now - 1 }),
    "another tool": sign({ aud: "notes" }),
    "audience list": sign({ aud: ["web"] }),
    "no subject": sign({ sub: "" }),
    "claim missing": sign({ email: undefined }),
    "claim of another type": sign({ admin: "true" }),
    "tampered payload": header + "." + encode({ ...JSON.parse(Buffer.from(payload, "base64url").toString()) as object, admin: true }) + "." + signature,
    "tampered signature": header + "." + payload + "." + signature.slice(0, -2) + (signature.endsWith("AA") ? "BB" : "AA"),
    "repeated header": [sign(), sign()],
    "too long": sign({ name: "x".repeat(9000) }),
  };
  for (const [name, value] of Object.entries(cases)) {
    assert.equal(member(web(value)), null, "Web Request: " + name);
    assert.equal(member(node(value)), null, "Node request: " + name);
  }
});

test("without CHEST_TOKEN or CHEST_TOOL, nobody is a member", () => {
  const assertion = sign();
  assert.notEqual(member(web(assertion)), null);
  delete process.env["CHEST_TOOL"];
  assert.equal(member(web(assertion)), null);
  process.env["CHEST_TOOL"] = "web";
  delete process.env["CHEST_TOKEN"];
  assert.equal(member(node(assertion)), null);
  process.env["CHEST_TOKEN"] = "short";
  assert.equal(member(node(assertion)), null);
});
