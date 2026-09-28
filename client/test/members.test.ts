import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, mock, test } from "node:test";
import { CapabilityNotGranted, ChestError, RateLimited, Unavailable } from "../src/errors.js";
import * as members from "../src/members.js";

// A Chest's API as chest/toolmembers of the Chest repository answers it: the
// SDK is tested against its routes, its shapes and its codes.
const id = (name: string): string => "mbr_" + name + "a".repeat(26 - name.length);
const nord = "grp_nordaaaaaaaaaaaaaaaaaaaaaa";
const camille = { id: id("camille"), first_name: "Camille", last_name: "Martin", name: "Camille Martin", photo: "/_chest/members/" + id("camille") + "/photo?v=abcdefgh", role: "editor", admin: true, builder: false, groups: [nord] };
const dan = { id: id("dan"), first_name: "", last_name: "", name: "dan", photo: null, role: null, admin: false, builder: true, groups: [] };
const sdkCamille = { id: id("camille"), firstName: "Camille", lastName: "Martin", name: "Camille Martin", photo: camille.photo, role: "editor", isAdmin: true, isBuilder: false, groups: [nord] };

let seen: { method: string; url: string; body: string }[] = [];
let reply: (url: URL, body: string) => { status: number; value: unknown } = () => ({ status: 404, value: { error: "not_found" } });

function answer(response: ServerResponse, status: number, value: unknown): void {
  const raw = JSON.stringify(value);
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(raw)) }).end(raw);
}
const server: Server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString();
  seen.push({ method: request.method ?? "", url: request.url ?? "", body });
  const { status, value } = reply(new URL(request.url ?? "/", "http://127.0.0.1"), body);
  answer(response, status, value);
});

const given = process.env["CHEST_API"];
before(async () => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  process.env["CHEST_API"] = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
});
after(() => {
  server.close();
  if (given === undefined) delete process.env["CHEST_API"];
  else process.env["CHEST_API"] = given;
});
afterEach(() => {
  seen = [];
  members.forget();
  mock.timers.reset();
});

test("list asks one page with what it is given, and reads the Chest's members", async () => {
  reply = () => ({ status: 200, value: { members: [camille, dan], next: "Y3Vyc29y" } });
  const page = await members.list({ q: "cam ma", limit: 2, role: "editor", group: nord, after: "YWZ0ZXI" });
  assert.deepEqual(seen.map(s => s.url), ["/members?after=YWZ0ZXI&limit=2&q=cam+ma&role=editor&group=" + nord]);
  assert.deepEqual(page, { members: [sdkCamille, { id: id("dan"), firstName: "", lastName: "", name: "dan", photo: null, role: null, isAdmin: false, isBuilder: true, groups: [] }], next: "Y3Vyc29y" });
  reply = () => ({ status: 200, value: { members: [{ ...dan, email: "dan@example.test" }], next: null } });
  assert.equal((await members.list()).members[0]?.email, "dan@example.test");
  assert.equal(seen.at(-1)?.url, "/members");
  for (const bad of [{ limit: 0 }, { limit: 501 }, { limit: 1.5 }, { group: "nord" }]) {
    await assert.rejects(members.list(bad), (error: unknown) => error instanceof ChestError && error.code === "invalid_query", JSON.stringify(bad));
  }
});

test("get is a member, or null for an identifier the tool does not know", async () => {
  reply = url => url.pathname === "/members/" + id("camille") ? { status: 200, value: camille } : { status: 404, value: { error: "member_not_found" } };
  assert.deepEqual(await members.get(id("camille")), sdkCamille);
  assert.equal(await members.get(id("mallory")), null);
  await assert.rejects(members.get("alice"), (error: unknown) => error instanceof ChestError && error.code === "invalid_id" && error.status === 400);
  assert.equal(seen.length, 2);
});

test("lookup asks 200 identifiers at a time, each once, and keeps the answers a minute", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_790_000_000_000 });
  reply = (_, body) => {
    const ids = (JSON.parse(body) as { ids: string[] }).ids;
    return { status: 200, value: { members: ids.includes(camille.id) ? [camille] : [], former: ids.includes(id("eve")) ? [{ id: id("eve"), name: "Eve", status: "former" }] : [], unknown: ids.filter(x => x !== camille.id && x !== id("eve")) } };
  };
  const many = Array.from({ length: 450 }, (_, i) => id("x" + String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26) % 26) + String.fromCharCode(97 + Math.floor(i / 676))));
  const found = await members.lookup([id("eve"), camille.id, ...many, camille.id]);
  assert.deepEqual(seen.map(s => (JSON.parse(s.body) as { ids: string[] }).ids.length), [200, 200, 52]);
  assert.deepEqual(found.members, [sdkCamille]);
  assert.deepEqual(found.former, [{ id: id("eve"), name: "Eve", status: "former" }]);
  assert.equal(found.unknown.length, 450);
  // Kept: asked again within the minute, the Chest is not called.
  seen = [];
  assert.deepEqual((await members.lookup([camille.id])).members, [sdkCamille]);
  assert.equal(seen.length, 0);
  mock.timers.setTime(1_790_000_060_000);
  await members.lookup([camille.id]);
  assert.equal(seen.length, 1);
  await assert.rejects(members.lookup(["alice"]), (error: unknown) => error instanceof ChestError && error.code === "invalid_id");
  // An answer that does not account for every identifier is not the Chest's.
  members.forget();
  reply = () => ({ status: 200, value: { members: [], former: [], unknown: [] } });
  await assert.rejects(members.lookup([camille.id]), Unavailable);
});

test("groups are those that give the tool", async () => {
  reply = () => ({ status: 200, value: { groups: [{ id: nord, name: "Nord", members: [camille.id] }] } });
  assert.deepEqual(await members.groups.list(), [{ id: nord, name: "Nord", members: [camille.id] }]);
  assert.equal(seen.at(-1)?.url, "/groups");
});

test("the Chest's refusals are errors the tool tests; an answer of another shape is Unavailable", async () => {
  for (const [status, code, kind] of [[403, "capability_not_granted", CapabilityNotGranted], [429, "rate_limited", RateLimited], [503, "unavailable", Unavailable]] as const) {
    reply = () => ({ status, value: { error: code } });
    await assert.rejects(members.list(), (error: unknown) => error instanceof kind && error.status === status && error.code === code, code);
  }
  for (const value of [{ members: [{ ...camille, id: "alice" }], next: null }, { members: [{ ...camille, groups: ["nord"] }], next: null }, { members: [{ ...camille, admin: "yes" }], next: null }, { members: "x", next: null }]) {
    reply = () => ({ status: 200, value });
    await assert.rejects(members.list(), Unavailable);
  }
  const address = process.env["CHEST_API"];
  delete process.env["CHEST_API"];
  try {
    await assert.rejects(members.get(camille.id), (error: unknown) => error instanceof CapabilityNotGranted && error.message.includes('"members"'));
  } finally {
    process.env["CHEST_API"] = address;
  }
});
