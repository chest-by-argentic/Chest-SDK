import assert from "node:assert/strict";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { mock, test } from "node:test";
import { CapabilityNotGranted, ChestError, QuotaExceeded, RateLimited, TooLarge } from "../src/errors.js";
import * as files from "../src/files.js";
import { member, type Member } from "../src/member.js";
import * as members from "../src/members.js";
import * as notifications from "../src/notifications.js";
import { fakeChest, signAssertion, withMember } from "../src/testing.js";

const id = (name: string): string => "mbr_" + name + "a".repeat(26 - name.length);
const nord = "grp_nordaaaaaaaaaaaaaaaaaaaaaa";
const camille: Member = { id: id("camille"), firstName: "Camille", lastName: "Martin", name: "Camille Martin", photo: null, role: "editor", isAdmin: false, isBuilder: false, groups: [nord], email: "camille@example.test" };
const emile: Member = { id: id("emile"), firstName: "Émile", lastName: "Durand", name: "Émile Durand", photo: null, role: "reader", isAdmin: true, isBuilder: false, groups: [] };
const zoe: Member = { id: id("zoe"), firstName: "Zoé", lastName: "Petit", name: "Zoé Petit", photo: null, role: "reader", isAdmin: false, isBuilder: true, groups: [] };

test("a fake Chest points the environment at itself, and restores it when closed", async () => {
  process.env["CHEST_TOOL"] = "notes";
  delete process.env["CHEST_API"];
  delete process.env["CHEST_TOKEN"];
  const chest = await fakeChest({ members: [camille] });
  try {
    assert.equal(process.env["CHEST_API"], chest.api);
    assert.match(chest.api, /^http:\/\/127\.0\.0\.1:[0-9]+$/u);
    assert.equal(process.env["CHEST_TOKEN"], chest.token);
    assert.equal(chest.tool, "notes");
  } finally {
    await chest.close();
  }
  assert.equal(process.env["CHEST_API"], undefined);
  assert.equal(process.env["CHEST_TOKEN"], undefined);
  assert.equal(process.env["CHEST_TOOL"], "notes");
  delete process.env["CHEST_TOOL"];
});

test("an assertion signed for a member reads as that member, on a Web Request and a Node request", async () => {
  const chest = await fakeChest();
  try {
    assert.deepEqual(member(withMember(new Request("http://tool.test/chest"), camille)), camille);
    const request = withMember(new IncomingMessage(new Socket()), emile);
    assert.deepEqual(member(request), emile);
    // Signed for another tool, or long ago, it is nobody.
    assert.equal(member(withMember(new Request("http://tool.test/chest"), camille, { tool: "other" })), null);
    assert.equal(member(withMember(new Request("http://tool.test/chest"), camille, { now: new Date(Date.now() - 120_000) })), null);
    assert.throws(() => signAssertion({ ...camille, id: "camille" }), /identifiers/u);
  } finally {
    await chest.close();
  }
  assert.throws(() => signAssertion(camille), /token/u);
});

test("its members answer as a Chest's: order, pages, search, lookup, groups, addresses only with members.email", async () => {
  const chest = await fakeChest({ members: [zoe, camille, emile], former: [{ id: id("dan"), name: "Dan" }, { id: id("eve"), name: "Eve", erased: true }], groups: [{ id: nord, name: "Nord", members: [camille.id] }], capabilities: ["members"] });
  try {
    const first = await members.list({ limit: 2 });
    assert.deepEqual(first.members.map(m => m.name), ["Camille Martin", "Émile Durand"]);
    assert.equal(first.members[0]?.email, undefined);
    assert.deepEqual((await members.list({ after: first.next! })).members.map(m => m.name), ["Zoé Petit"]);
    assert.deepEqual((await members.list({ q: "emi" })).members.map(m => m.id), [emile.id]);
    assert.deepEqual((await members.list({ group: nord })).members.map(m => m.id), [camille.id]);
    assert.equal(await members.get(id("mallory")), null);
    const found = await members.lookup([id("dan"), zoe.id, id("mallory")]);
    assert.deepEqual([found.members.map(m => m.id), found.former, found.unknown], [[zoe.id], [{ id: id("dan"), name: "Dan", status: "former" }], [id("mallory")]]);
    // Erased, a former member has no name any more.
    assert.deepEqual((await members.lookup([id("eve")])).former, [{ id: id("eve"), name: null, status: "erased" }]);
    assert.deepEqual(await members.groups.list(), [{ id: nord, name: "Nord", members: [camille.id] }]);
    await assert.rejects(files.get("a.txt"), CapabilityNotGranted);
  } finally {
    await chest.close();
  }
  const withEmail = await fakeChest({ members: [camille], capabilities: ["members", "members.email"] });
  try {
    assert.equal((await members.get(camille.id))?.email, "camille@example.test");
  } finally {
    await withEmail.close();
  }
});

test("its bounds and refusals are a Chest's", async () => {
  const chest = await fakeChest({ members: [camille], capabilities: ["files"], files: { "hello.txt": { data: "hello", type: "text/plain" } } });
  try {
    await assert.rejects(members.list(), CapabilityNotGranted);
    assert.equal(new TextDecoder().decode((await files.get("hello.txt"))?.data), "hello");
    await files.put("notes/a.txt", "a");
    assert.equal((await files.stat("notes/a.txt"))?.size, 1);
    assert.equal(await files.stat("none.txt"), null);
    assert.equal((await files.move("notes/a.txt", "notes/b.txt")).name, "notes/b.txt");
    assert.equal((await files.move("notes/b.txt", "notes/a.txt")).name, "notes/a.txt");
    assert.match((await files.uploadUrl("photos/", { maxSize: 1024, types: ["image/*"] })).url, /^https:\/\/tool-chest\.chest\.test\/_chest\/files\/upload\//u);
    assert.deepEqual([...chest.files.keys()].sort(), ["hello.txt", "notes/a.txt"]);
    assert.match((await files.url("notes/a.txt")).url, /^https:\/\/tool-chest\.chest\.test\/_chest\/files\//u);
    await assert.rejects(files.url("none.txt"), (error: unknown) => error instanceof ChestError && error.code === "not_found");
    assert.equal(await files.delete("hello.txt"), true);
    await assert.rejects(files.put("big", new Uint8Array((32 << 20) + 1)), TooLarge);
  } finally {
    await chest.close();
  }
  const busy = await fakeChest({ members: [camille] });
  try {
    for (let i = 0; i < 600; i++) await members.groups.list();
    await assert.rejects(members.groups.list(), RateLimited);
  } finally {
    await busy.close();
  }
});

test("its notifications and badges are kept as a Chest keeps them: cleaned, replaced by key, withdrawn", async () => {
  const chest = await fakeChest({ members: [camille, emile] });
  const sent = chest.notifications;
  try {
    const mallory = id("mallory");
    assert.deepEqual(await notifications.notify([camille.id, mallory, emile.id, camille.id], { title: "\u202eNew\ttask\u0007 ", body: " Fix\r\nthe\tdoor\u0000\u200f ", key: "task:1" }), { delivered: [camille.id, emile.id], skipped: [mallory] });
    assert.deepEqual(sent, [{ member: camille.id, title: "New task", body: "Fix\nthe door", path: "/chest", key: "task:1" }, { member: emile.id, title: "New task", body: "Fix\nthe door", path: "/chest", key: "task:1" }]);
    await notifications.notify([emile.id], { title: "Other", path: "/chest/other" });
    // The same key for the same member replaces the item, now the last.
    await notifications.notify([camille.id], { title: "Task changed", path: "/chest/tasks/1", key: "task:1" });
    assert.deepEqual(sent.map(n => [n.member, n.title]), [[emile.id, "New task"], [emile.id, "Other"], [camille.id, "Task changed"]]);
    assert.equal(sent[2]?.body, undefined);
    await notifications.withdraw("task:1", [emile.id]);
    assert.deepEqual(sent.map(n => [n.member, n.title]), [[emile.id, "Other"], [camille.id, "Task changed"]]);
    await notifications.withdraw("task:1");
    assert.deepEqual(sent.map(n => n.title), ["Other"]);

    assert.equal(await notifications.badge.set(camille.id, 3), true);
    assert.equal(await notifications.badge.set(mallory, 3), false);
    assert.deepEqual(await notifications.badge.setMany([{ memberId: emile.id, count: 12 }, { memberId: mallory, count: 1 }, { memberId: camille.id, count: 0 }]), { set: [emile.id, camille.id], skipped: [mallory] });
    assert.deepEqual([...chest.badges], [[emile.id, 12]]);

    // What the SDK refuses before sending, the fake Chest refuses too.
    const raw = async (method: string, path: string, value: unknown) => {
      const response = await fetch(chest.api + path, { method, body: JSON.stringify(value) });
      return [response.status, response.status === 204 ? null : (await response.json() as { error?: string }).error ?? "ok"];
    };
    assert.deepEqual(await raw("POST", "/notifications", { members: [camille.id], title: "a", extra: 1 }), [400, "invalid_body"]);
    assert.deepEqual(await raw("POST", "/notifications", { members: [], title: "a" }), [400, "invalid_body"]);
    assert.deepEqual(await raw("POST", "/notifications", { members: ["alice"], title: "a" }), [400, "invalid_id"]);
    assert.deepEqual(await raw("POST", "/notifications", { members: [camille.id], title: "\u200e\n" }), [400, "invalid_title"]);
    assert.deepEqual(await raw("POST", "/notifications", { members: [camille.id], title: "a", body: "x".repeat(281) }), [400, "invalid_text"]);
    assert.deepEqual(await raw("POST", "/notifications", { members: [camille.id], title: "a", path: "/chest/%2e%2E/x" }), [400, "invalid_path"]);
    assert.deepEqual(await raw("POST", "/notifications", { members: [camille.id], title: "a", key: "A" }), [400, "invalid_key"]);
    assert.deepEqual(await raw("POST", "/notifications/withdraw", { key: "a", members: [] }), [400, "invalid_body"]);
    assert.deepEqual(await raw("PUT", "/badges/alice", { count: 1 }), [400, "invalid_id"]);
    assert.deepEqual(await raw("PUT", "/badges/" + camille.id, { count: 10000 }), [400, "invalid_count"]);
    assert.deepEqual(await raw("PUT", "/badges", { badges: [{ member: camille.id, count: 1 }, { member: camille.id, count: 2 }] }), [400, "invalid_body"]);
    assert.deepEqual(await raw("PUT", "/badges", { badges: [{ member: camille.id, count: -1 }] }), [400, "invalid_count"]);
    assert.deepEqual(await raw("GET", "/notifications", undefined), [404, "not_found"]);
    assert.deepEqual(sent.map(n => n.title), ["Other"]);
  } finally {
    await chest.close();
  }
  const without = await fakeChest({ members: [camille], capabilities: ["members"] });
  try {
    await assert.rejects(notifications.notify([camille.id], { title: "a" }), CapabilityNotGranted);
    await assert.rejects(notifications.badge.set(camille.id, 1), CapabilityNotGranted);
  } finally {
    await without.close();
  }
});

test("its notification quotas are a Chest's, and a refused call changes nothing", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_790_000_000_000 });
  const many = Array.from({ length: 500 }, (_, i) => ({ ...zoe, id: id("m" + String.fromCharCode(97 + (i % 26), 97 + Math.floor(i / 26))) }));
  const chest = await fakeChest({ members: [camille, ...many] });
  try {
    const ids = many.map(m => m.id);
    // 1,000 recipients an hour, from the first call.
    await notifications.notify(ids, { title: "a" });
    mock.timers.setTime(1_790_000_000_000 + 1_800_000);
    await notifications.notify(ids, { title: "b" });
    await assert.rejects(notifications.notify([camille.id], { title: "c" }), QuotaExceeded);
    const response = await fetch(chest.api + "/notifications", { method: "POST", body: JSON.stringify({ members: [camille.id], title: "c" }) });
    assert.deepEqual([response.status, response.headers.get("retry-after")], [429, "1800"]);
    await response.body?.cancel();
    assert.equal(chest.notifications.length, 1000);
    mock.timers.setTime(1_790_000_000_000 + 3_600_000);
    await notifications.notify([camille.id], { title: "c" });
    // 100 items per member a day, replacements counted: a member at 100
    // refuses the whole call.
    for (let i = 1; i < 100; i++) await notifications.notify([camille.id], { title: "d", key: "same" });
    await assert.rejects(notifications.notify([camille.id, ids[0]!], { title: "e" }), QuotaExceeded);
    assert.equal(chest.notifications.filter(n => n.member === camille.id).length, 2);
    // Recipients without access are not counted.
    assert.deepEqual(await notifications.notify([id("mallory")], { title: "f" }), { delivered: [], skipped: [id("mallory")] });
    mock.timers.setTime(1_790_000_000_000 + 3_600_000 + 86_400_000);
    await notifications.notify([camille.id], { title: "g" });
    // 600 badge writes a minute, each badge of setMany one.
    await notifications.badge.setMany(ids.map(memberId => ({ memberId, count: 1 })));
    await notifications.badge.setMany(ids.slice(0, 100).map(memberId => ({ memberId, count: 2 })));
    await assert.rejects(notifications.badge.set(camille.id, 1), QuotaExceeded);
    assert.equal(chest.badges.has(camille.id), false);
    mock.timers.setTime(1_790_000_000_000 + 3_600_000 + 86_400_000 + 60_000);
    assert.equal(await notifications.badge.set(camille.id, 1), true);
  } finally {
    await chest.close();
    mock.timers.reset();
  }
});
