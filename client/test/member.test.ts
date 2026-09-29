import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, mock, test } from "node:test";
import { member } from "../src/member.js";

// An assertion the Chest's front signed (chest/toolfront.Assertion, Go), for
// the tool "web", at 1790000000, with the instance key 00 01 … 1f, for Alice,
// spoken to in French, working in Europe/Paris: the derivation of the key and the encoding are the
// Chest's, not this test's.
const chestToken = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const signedByChest = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhZG1pbiI6dHJ1ZSwiYXVkIjoid2ViIiwiYnVpbGRlciI6ZmFsc2UsImVtYWlsIjoiYWxpY2VAZXhhbXBsZS50ZXN0IiwiZXhwIjoxNzkwMDAwMDYwLCJmYW1pbHlfbmFtZSI6Ik1hcnRpbiIsImdpdmVuX25hbWUiOiJBbGljZSIsImdyb3VwcyI6WyJncnBfbjRyZHE3dzJ4a3o1bTNidmM2aHkydHBsNGUiXSwiaWF0IjoxNzkwMDAwMDAwLCJpc3MiOiJodHRwczovL3dlYi1jaGVzdC5hdGVsaWVyLmV4YW1wbGUiLCJsYW5ndWFnZSI6ImZyIiwibmFtZSI6IkFsaWNlIE1hcnRpbiIsInBpY3R1cmUiOiIvX2NoZXN0L21lbWJlcnMvbWJyX2sycWh4NG16Yzd2M2I2bmZwNXIydDd3NHlhL3Bob3RvP3Y9YWJjZGVmZ2giLCJyb2xlIjoiZWRpdG9yIiwic3ViIjoibWJyX2sycWh4NG16Yzd2M2I2bmZwNXIydDd3NHlhIiwidGltZV96b25lIjoiRXVyb3BlL1BhcmlzIn0.Gn-eYBi3X4qkdZeL0IOT8p7QYUAURLZxeTh7UeUQrQI";
const signedAt = 1790000000;
const alice = { id: "mbr_k2qhx4mzc7v3b6nfp5r2t7w4ya", firstName: "Alice", lastName: "Martin", name: "Alice Martin", photo: "/_chest/members/mbr_k2qhx4mzc7v3b6nfp5r2t7w4ya/photo?v=abcdefgh", role: "editor", isAdmin: true, isBuilder: false, groups: ["grp_n4rdq7w2xkz5m3bvc6hy2tpl4e"], email: "alice@example.test", language: "fr", timeZone: "Europe/Paris" };
const bob = "mbr_bobaaaaaaaaaaaaaaaaaaaaaaa";

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const keyOf = (token: string, label = "Chest-Member v2"): Buffer => createHmac("sha256", Buffer.from(token, "utf8")).update(label).digest();
// sign builds an assertion as the Chest does, with what a case changes.
function sign(claims: Record<string, unknown> = {}, header: Record<string, unknown> = { alg: "HS256", typ: "JWT" }, token = chestToken, label?: string): string {
  const now = Math.floor(Date.now() / 1000);
  const body = encode(header) + "." + encode({ iss: "https://web-chest.atelier.example", aud: "web", iat: now, exp: now + 60, sub: bob, given_name: "Bob", family_name: "", name: "Bob", picture: "", role: "", admin: false, builder: false, groups: [], language: "en", time_zone: "America/New_York", ...claims });
  return body + "." + createHmac("sha256", keyOf(token, label)).update(body).digest("base64url");
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

test("photo and role are null when the Chest names none; the address is there only when the tool may read it", () => {
  assert.deepEqual(member(web(sign())), { id: bob, firstName: "Bob", lastName: "", name: "Bob", photo: null, role: null, isAdmin: false, isBuilder: false, groups: [], timeZone: "America/New_York", language: "en" });
  assert.deepEqual(member(node(sign({ role: "reader", builder: true, email: "bob@example.test" }))), { id: bob, firstName: "Bob", lastName: "", name: "Bob", photo: null, role: "reader", isAdmin: false, isBuilder: true, groups: [], timeZone: "America/New_York", email: "bob@example.test", language: "en" });
});

test("a language is any primary tag; nothing of the Chest itself is a member's", () => {
  assert.equal(member(web(sign({ language: "de" })))?.language, "de");
  assert.equal(member(web(sign({ language: "haw" })))?.language, "haw");
  // A claim the member does not have is not read: the organization is the
  // Chest's (the chest module).
  assert.equal(Object.hasOwn(member(web(sign({ organization: "Acme SAS" })))!, "organization"), false);
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
    "a provider subject": sign({ sub: "0b0e6e8c-5a59-4f6e-9a39-0d4a8d2f7b11" }),
    "claim missing": sign({ groups: undefined }),
    "groups of another shape": sign({ groups: ["nord"] }),
    "groups not a list": sign({ groups: "grp_n4rdq7w2xkz5m3bvc6hy2tpl4e" }),
    "address of another type": sign({ email: 1 }),
    "language missing": sign({ language: undefined }),
    "language a word": sign({ language: "french" }),
    "language in capitals": sign({ language: "EN" }),
    "language a region": sign({ language: "fr-FR" }),
    "language a number": sign({ language: 3 }),
    "time zone missing": sign({ time_zone: undefined }),
    "time zone an alias": sign({ time_zone: "CET" }),
    "time zone a path": sign({ time_zone: "../etc/localtime" }),
    "time zone an offset": sign({ time_zone: "+02:00" }),
    "signed for the former shape": sign({}, undefined, chestToken, "Chest-Member v1"),
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
