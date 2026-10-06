import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, test } from "node:test";
import { CapabilityNotGranted, ChestError, RateLimited, Unavailable } from "../src/errors.js";
import * as notifications from "../src/notifications.js";

// A Chest's API as its notifications answer (badges, inbox items): the SDK is
// tested against its routes, its shapes and its codes.
const id = (name: string): string => "mbr_" + name + "a".repeat(26 - name.length);
const camille = id("camille"), dan = id("dan"), eve = id("eve");

let seen: { method: string; url: string; type: string | undefined; body: unknown }[] = [];
let reply: (url: URL, body: Record<string, unknown>) => { status: number; value?: unknown } = () => ({ status: 404, value: { error: "not_found" } });

function answer(response: ServerResponse, status: number, value?: unknown): void {
  if (value === undefined) return void response.writeHead(status).end();
  const raw = JSON.stringify(value);
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(raw)) }).end(raw);
}
const server: Server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const body = JSON.parse(Buffer.concat(chunks).toString() || "null") as Record<string, unknown>;
  seen.push({ method: request.method ?? "", url: request.url ?? "", type: request.headers["content-type"], body });
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
});

const code = (expected: string) => (error: unknown) => error instanceof ChestError && error.code === expected && error.status === 400;

test("notify sends the recipients and the notice as given, and reads who got it", async () => {
  reply = () => ({ status: 200, value: { delivered: [camille, eve], skipped: [dan] } });
  const sent = await notifications.notify([camille, dan, eve, camille], { title: "New task", body: "Fix the door\nby Friday", path: "/chest/tasks/42?tab=notes#top", key: "task:42" });
  assert.deepEqual(sent, { delivered: [camille, eve], skipped: [dan] });
  assert.deepEqual(seen, [{ method: "POST", url: "/notifications", type: "application/json", body: { members: [camille, dan, eve, camille], title: "New task", body: "Fix the door\nby Friday", path: "/chest/tasks/42?tab=notes#top", key: "task:42" } }]);
  // Only the title when nothing else is said; an empty body is none.
  reply = () => ({ status: 200, value: { delivered: [], skipped: [dan] } });
  assert.deepEqual(await notifications.notify(new Set([dan]), { title: "Hi", body: "" }), { delivered: [], skipped: [dan] });
  assert.deepEqual(seen.at(-1)?.body, { members: [dan], title: "Hi" });
});

test("notify refuses what the Chest would refuse, before sending anything", async () => {
  const bad: [Iterable<string>, notifications.Notice, string][] = [
    [[], { title: "a" }, "invalid_body"],
    [["alice"], { title: "a" }, "invalid_id"],
    [[camille], { title: "" }, "invalid_title"],
    [[camille], { title: "x".repeat(81) }, "invalid_title"],
    [[camille], { title: " \t\u200e\u0007 " }, "invalid_title"],
    [[camille], { title: 42 as unknown as string }, "invalid_title"],
    [[camille], { title: "a", body: "x".repeat(281) }, "invalid_text"],
    [[camille], { title: "a", path: "/other" }, "invalid_path"],
    [[camille], { title: "a", path: "/chester" }, "invalid_path"],
    [[camille], { title: "a", path: "https://evil.example/chest" }, "invalid_path"],
    [[camille], { title: "a", path: "/chest//evil.example" }, "invalid_path"],
    [[camille], { title: "a", path: "/chest/../admin" }, "invalid_path"],
    [[camille], { title: "a", path: "/chest/%2E%2e/admin" }, "invalid_path"],
    [[camille], { title: "a", path: "/chest/a b" }, "invalid_path"],
    [[camille], { title: "a", path: "/chest/a\\b" }, "invalid_path"],
    [[camille], { title: "a", path: "/chest/é" }, "invalid_path"],
    [[camille], { title: "a", path: "/chest/" + "x".repeat(506) }, "invalid_path"],
    [[camille], { title: "a", key: "Task 42" }, "invalid_key"],
    [[camille], { title: "a", key: "k".repeat(65) }, "invalid_key"],
  ];
  for (const [ids, notice, expected] of bad) await assert.rejects(notifications.notify(ids, notice), code(expected), JSON.stringify(notice));
  assert.equal(seen.length, 0);
  // At the bounds, counted in characters (code points), it goes.
  reply = () => ({ status: 200, value: { delivered: [camille], skipped: [] } });
  await notifications.notify([camille], { title: "é".repeat(79) + "😀", body: "😀".repeat(280), path: "/chest/" + "x".repeat(505), key: "k".repeat(64) });
  await notifications.notify([camille], { title: "a", path: "/chest" });
  await notifications.notify([camille], { title: "a", path: "/chest/a.b/..c?x=../y" });
  assert.equal(seen.length, 3);
});

test("a notice in other languages sends each translation as given", async () => {
  reply = () => ({ status: 200, value: { delivered: [camille], skipped: [] } });
  await notifications.notify([camille], { title: "New poll", body: "Vote", translations: { fr: { title: "Nouveau sondage", body: "" }, de: { title: "Neue Umfrage" } } });
  assert.deepEqual(seen.at(-1)?.body, { members: [camille], title: "New poll", body: "Vote", translations: { fr: { title: "Nouveau sondage" }, de: { title: "Neue Umfrage" } } });
  for (const [translations, expected] of [[{ FR: { title: "a" } }, "invalid_language"], [{ french: { title: "a" } }, "invalid_language"], [{ fr: { title: "" } }, "invalid_title"], [{ fr: { title: "a", body: "x".repeat(281) } }, "invalid_text"]] as const) {
    await assert.rejects(notifications.notify([camille], { title: "a", translations: translations as Record<string, notifications.Words> }), code(expected), JSON.stringify(translations));
  }
  assert.equal(seen.length, 1);
});

test("broadcast sends the notice and whom it is for, and says nothing back", async () => {
  const sales = "grp_sales" + "a".repeat(21);
  reply = () => ({ status: 204 });
  assert.equal(await notifications.broadcast({ title: "Office closed", path: "/chest/news/3", key: "news:3", translations: { fr: { title: "Bureau fermé" } } }), undefined);
  await notifications.broadcast({ title: "Poll" }, { to: { groups: [sales], roles: ["editor"] }, except: new Set([camille]) });
  await notifications.broadcast({ title: "Poll" }, { to: { roles: ["editor"], groups: [] }, except: [] });
  assert.deepEqual(seen.map(s => [s.method, s.url, s.body]), [
    ["POST", "/notifications/broadcast", { title: "Office closed", path: "/chest/news/3", key: "news:3", translations: { fr: { title: "Bureau fermé" } } }],
    ["POST", "/notifications/broadcast", { title: "Poll", to: { groups: [sales], roles: ["editor"] }, except: [camille] }],
    ["POST", "/notifications/broadcast", { title: "Poll", to: { roles: ["editor"] } }],
  ]);
  seen = [];
  const bad: [notifications.Notice, notifications.Audience, string][] = [
    [{ title: "" }, {}, "invalid_title"],
    [{ title: "a" }, { to: {} }, "invalid_body"],
    [{ title: "a" }, { to: { groups: [], roles: [] } }, "invalid_body"],
    [{ title: "a" }, { to: { groups: ["sales"] } }, "invalid_id"],
    [{ title: "a" }, { to: { roles: ["Editor"] } }, "invalid_role"],
    [{ title: "a" }, { to: { roles: Array.from({ length: 17 }, (_, i) => "r" + i) } }, "invalid_body"],
    [{ title: "a" }, { except: ["alice"] }, "invalid_id"],
    [{ title: "a", path: "/public" }, {}, "invalid_path"],
  ];
  for (const [notice, audience, expected] of bad) await assert.rejects(notifications.broadcast(notice, audience), code(expected), JSON.stringify([notice, audience]));
  assert.equal(seen.length, 0);
  // A 200 is not what the Chest answers.
  reply = () => ({ status: 200, value: { delivered: 3 } });
  await assert.rejects(notifications.broadcast({ title: "a" }), Unavailable);
});

test("withdraw names the key, and the members when given; it says nothing of what existed", async () => {
  reply = () => ({ status: 204 });
  assert.equal(await notifications.withdraw("task:42"), undefined);
  await notifications.withdraw("task:42", [camille]);
  assert.deepEqual(seen.map(s => [s.method, s.url, s.body]), [["POST", "/notifications/withdraw", { key: "task:42" }], ["POST", "/notifications/withdraw", { key: "task:42", members: [camille] }]]);
  await assert.rejects(notifications.withdraw("Task"), code("invalid_key"));
  await assert.rejects(notifications.withdraw("task:42", []), code("invalid_body"));
  await assert.rejects(notifications.withdraw("task:42", ["alice"]), code("invalid_id"));
  // A 200 is not what the Chest answers.
  reply = () => ({ status: 200, value: {} });
  await assert.rejects(notifications.withdraw("task:42"), Unavailable);
});

test("badge.set puts one count and says whether the member has the tool", async () => {
  reply = url => url.pathname === "/badges/" + camille ? { status: 200, value: { set: [camille], skipped: [] } } : { status: 200, value: { set: [], skipped: [dan] } };
  assert.equal(await notifications.badge.set(camille, 3), true);
  assert.equal(await notifications.badge.set(dan, 0), false);
  assert.deepEqual(seen.map(s => [s.method, s.url, s.body]), [["PUT", "/badges/" + camille, { count: 3 }], ["PUT", "/badges/" + dan, { count: 0 }]]);
  for (const count of [-1, 10000, 1.5, Number.NaN]) await assert.rejects(notifications.badge.set(camille, count), code("invalid_count"));
  await assert.rejects(notifications.badge.set("alice", 1), code("invalid_id"));
  assert.equal(seen.length, 2);
});

test("badge.setMany puts up to 500 counts, a member once", async () => {
  reply = () => ({ status: 200, value: { set: [camille, eve], skipped: [dan] } });
  assert.deepEqual(await notifications.badge.setMany([{ memberId: camille, count: 1 }, { memberId: dan, count: 2 }, { memberId: eve, count: 0 }]), { set: [camille, eve], skipped: [dan] });
  assert.deepEqual(seen[0]?.body, { badges: [{ member: camille, count: 1 }, { member: dan, count: 2 }, { member: eve, count: 0 }] });
  await assert.rejects(notifications.badge.setMany([]), code("invalid_body"));
  await assert.rejects(notifications.badge.setMany([{ memberId: camille, count: 1 }, { memberId: camille, count: 2 }]), code("invalid_body"));
  await assert.rejects(notifications.badge.setMany([null as unknown as notifications.BadgeCount]), code("invalid_body"));
  await assert.rejects(notifications.badge.setMany([{ memberId: "alice", count: 1 }]), code("invalid_id"));
  await assert.rejects(notifications.badge.setMany([{ memberId: camille, count: 10000 }]), code("invalid_count"));
  assert.equal(seen.length, 1);
});

test("the Chest's refusals are errors the tool tests", async () => {
  for (const [status, value, kind] of [[403, "capability_not_granted", CapabilityNotGranted], [429, "rate_limited", RateLimited], [503, "unavailable", Unavailable]] as const) {
    reply = () => ({ status, value: { error: value } });
    await assert.rejects(notifications.notify([camille], { title: "a" }), (error: unknown) => error instanceof kind && error.code === value, value);
    await assert.rejects(notifications.badge.set(camille, 1), kind, value);
  }
  reply = () => ({ status: 403, value: { error: "capability_not_granted" } });
  await assert.rejects(notifications.withdraw("k"), (error: unknown) => error instanceof CapabilityNotGranted && error.message.includes('"notifications"'));
  reply = () => ({ status: 400, value: { error: "invalid_title" } });
  await assert.rejects(notifications.notify([camille], { title: "a" }), code("invalid_title"));
  const address = process.env["CHEST_API"];
  delete process.env["CHEST_API"];
  try {
    await assert.rejects(notifications.notify([camille], { title: "a" }), CapabilityNotGranted);
  } finally {
    process.env["CHEST_API"] = address;
  }
});

test("an answer that does not split the identifiers asked, each once in their order, is not the Chest's", async () => {
  const forged = [
    { delivered: [camille], skipped: [] },
    { delivered: [dan, camille], skipped: [] },
    { delivered: [camille, dan], skipped: [dan] },
    { delivered: [camille, camille], skipped: [] },
    { delivered: [camille, eve], skipped: [] },
    { delivered: [camille], skipped: [7] },
    { delivered: [camille, dan] },
    [camille, dan],
    null,
  ];
  for (const value of forged) {
    reply = () => ({ status: 200, value });
    await assert.rejects(notifications.notify([camille, dan, camille], { title: "a" }), Unavailable, JSON.stringify(value));
  }
  for (const value of [{ set: [dan], skipped: [] }, { set: [camille], skipped: [camille] }, { set: [], skipped: [] }, { set: true }]) {
    reply = () => ({ status: 200, value });
    await assert.rejects(notifications.badge.set(camille, 1), Unavailable, JSON.stringify(value));
  }
  reply = () => ({ status: 201, value: { delivered: [camille], skipped: [] } });
  await assert.rejects(notifications.notify([camille], { title: "a" }), Unavailable);
  reply = () => ({ status: 200, value: { set: [dan, camille], skipped: [] } });
  await assert.rejects(notifications.badge.setMany([{ memberId: camille, count: 1 }, { memberId: dan, count: 1 }]), Unavailable);
});
