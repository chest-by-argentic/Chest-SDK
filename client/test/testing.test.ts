import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { mock, test } from "node:test";
import * as ai from "../src/ai.js";
import { AiCapReached, AiModelNotAllowed, AiUnavailable, CapabilityNotGranted, ChestError, RateLimited, TooLarge } from "../src/errors.js";
import * as files from "../src/files.js";
import { member, type Member } from "../src/member.js";
import * as members from "../src/members.js";
import * as notifications from "../src/notifications.js";
import { fakeChest, signAssertion, withMember } from "../src/testing.js";
import { chest as theChest } from "../src/chest.js";

const id = (name: string): string => "mbr_" + name + "a".repeat(26 - name.length);
const nord = "grp_nordaaaaaaaaaaaaaaaaaaaaaa";
const camille: Member = { id: id("camille"), firstName: "Camille", lastName: "Martin", name: "Camille Martin", photo: null, role: "editor", isAdmin: false, isBuilder: false, groups: [nord], language: "en", timeZone: "Europe/Paris", email: "camille@example.test" };
const emile: Member = { id: id("emile"), firstName: "Émile", lastName: "Durand", name: "Émile Durand", photo: null, role: "reader", isAdmin: true, isBuilder: false, groups: [], language: "fr", timeZone: "America/New_York" };
const zoe: Member = { id: id("zoe"), firstName: "Zoé", lastName: "Petit", name: "Zoé Petit", photo: null, role: "reader", isAdmin: false, isBuilder: true, groups: [], language: "en", timeZone: "UTC" };

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
    assert.deepEqual([theChest.organization.name, theChest.timeZone, theChest.language, theChest.currency], ["Test organization", "UTC", "en", "EUR"]);
    assert.deepEqual(theChest.tool, { teamUrl: "https://notes-chest.chest.test", publicUrl: "https://notes.chest.test" });
  } finally {
    await chest.close();
  }
  assert.equal(process.env["CHEST_API"], undefined);
  assert.equal(process.env["CHEST_TOKEN"], undefined);
  assert.throws(() => theChest.timeZone, (e: unknown) => e instanceof ChestError && e.code === "not_in_chest");
  assert.equal(process.env["CHEST_TOOL"], "notes");
  delete process.env["CHEST_TOOL"];
});

test("an assertion signed for a member reads as that member, in its language, on a Web Request and a Node request", async () => {
  const chest = await fakeChest();
  try {
    assert.deepEqual(member(withMember(new Request("http://tool.test/chest"), camille)), camille);
    const request = withMember(new IncomingMessage(new Socket()), emile);
    assert.deepEqual(member(request), emile);
    // Signed as given: a language or a zone the Chest would never send is nobody.
    assert.equal(member(withMember(new Request("http://tool.test/chest"), { ...camille, language: "French" })), null);
    assert.equal(member(withMember(new Request("http://tool.test/chest"), { ...camille, timeZone: "CET" })), null);
    // Signed for another tool, or long ago, it is nobody.
    assert.equal(member(withMember(new Request("http://tool.test/chest"), camille, { tool: "other" })), null);
    assert.equal(member(withMember(new Request("http://tool.test/chest"), camille, { now: new Date(Date.now() - 120_000) })), null);
    assert.throws(() => signAssertion({ ...camille, id: "camille" }), /identifiers/u);
    // More groups than travel with a request: none, and the overage said —
    // the tool reads them with members.get.
    assert.deepEqual(member(withMember(new Request("http://tool.test/chest"), { ...camille, groups: null })), { ...camille, groups: null });
  } finally {
    await chest.close();
  }
  assert.throws(() => signAssertion(camille), /token/u);
});

test("its members answer as a Chest's: order, pages, search, lookup, groups, addresses only with members.email", async () => {
  const chest = await fakeChest({ members: [zoe, camille, emile], former: [{ id: id("dan"), name: "Dan" }, { id: id("eve"), name: "Eve", status: "erased" }, { id: id("rose"), name: "Rose Lemaire", status: "no_access" }], groups: [{ id: nord, name: "Nord", members: [camille.id] }], capabilities: ["members"] });
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
    // Without access to the tool, a member of the Chest keeps their name.
    assert.deepEqual((await members.lookup([id("rose")])).former, [{ id: id("rose"), name: "Rose Lemaire", status: "no_access" }]);
    assert.equal(await members.get(id("rose")), null);
    // Erased, a former member has no name any more.
    assert.deepEqual((await members.lookup([id("eve")])).former, [{ id: id("eve"), name: null, status: "erased" }]);
    assert.deepEqual(await members.groups.list(), { groups: [{ id: nord, name: "Nord", size: 1 }], next: null });
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

test("its groups that give nothing are seen only with members.groups, their members among those who have the tool", async () => {
  const sud = "grp_sudaaaaaaaaaaaaaaaaaaaaaaa";
  const inSud = { ...emile, groups: [sud] };
  const groups = [{ id: nord, name: "Nord", members: [camille.id] }, { id: sud, name: "Sud", members: [emile.id, id("mallory")], grants: false }];
  const narrow = await fakeChest({ members: [camille, inSud], groups, capabilities: ["members"] });
  try {
    assert.deepEqual((await members.groups.list()).groups, [{ id: nord, name: "Nord", size: 1 }]);
    assert.deepEqual((await members.get(emile.id))?.groups, []);
    assert.deepEqual((await members.list({ group: sud })).members, []);
  } finally {
    await narrow.close();
  }
  const every = await fakeChest({ members: [camille, inSud], groups, capabilities: ["members", "members.groups", "notifications"] });
  try {
    // Sud lists someone without the tool: not counted.
    assert.deepEqual((await members.groups.list()).groups, [{ id: nord, name: "Nord", size: 1 }, { id: sud, name: "Sud", size: 1 }]);
    const first = await members.groups.list({ limit: 1 });
    assert.deepEqual([first.groups.map(g => g.name), (await members.groups.list({ after: first.next!, limit: 1 })).groups.map(g => g.name)], [["Nord"], ["Sud"]]);
    assert.deepEqual((await members.get(emile.id))?.groups, [sud]);
    assert.deepEqual((await members.list({ group: sud })).members.map(m => m.id), [emile.id]);
  } finally {
    await every.close();
  }
});

test("its broadcast reaches whom a Chest's would, each in their language, and says nothing back", async () => {
  const sud = "grp_sudaaaaaaaaaaaaaaaaaaaaaaa";
  const chest = await fakeChest({ members: [camille, { ...emile, groups: [sud] }, zoe], groups: [{ id: sud, name: "Sud", members: [emile.id], grants: false }], capabilities: ["members", "members.groups", "notifications"] });
  const sent = chest.notifications;
  try {
    await notifications.broadcast({ title: "Office closed", key: "news:1", translations: { fr: { title: "Bureau fermé" } } }, { except: [zoe.id] });
    assert.deepEqual(sent, [{ member: camille.id, title: "Office closed", path: "/chest", key: "news:1" }, { member: emile.id, title: "Bureau fermé", path: "/chest", key: "news:1" }]);
    await notifications.broadcast({ title: "Sud" }, { to: { groups: [sud] } });
    await notifications.broadcast({ title: "Readers" }, { to: { roles: ["reader"] } });
    await notifications.broadcast({ title: "Nobody" }, { to: { groups: ["grp_" + "b".repeat(26)] } });
    assert.deepEqual(sent.slice(2).map(n => [n.member, n.title]), [[emile.id, "Sud"], [emile.id, "Readers"], [zoe.id, "Readers"]]);
    await notifications.withdraw("news:1");
    assert.equal(sent.length, 3);
    await assert.rejects(notifications.broadcast({ title: "a" }, { to: { roles: ["Reader"] } }), (e: unknown) => e instanceof ChestError && e.code === "invalid_role");
  } finally {
    await chest.close();
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
    assert.ok((await files.uploadUrl("photos/", { maxSize: 1024, types: ["image/*"] })).url.startsWith(chest.api + "/_chest/files/upload/"));
    assert.deepEqual([...chest.files.keys()].sort(), ["hello.txt", "notes/a.txt"]);
    assert.ok((await files.url("notes/a.txt")).url.startsWith(chest.api + "/_chest/files/"));
    await assert.rejects(files.uploadUrl("big/", { maxSize: (32 << 20) + 1 }), TooLarge);
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

test("its team host serves the links it signs and takes the uploads it authorises, as the Chest's does", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const chest = await fakeChest({ capabilities: ["files"], files: { "photos/cat.png": { data: png, type: "image/png" }, "notes.txt": { data: "hello", type: "text/plain" } } });
  try {
    // A link opens the content it was signed for; a thumbnail is of an image only.
    const link = await files.url("photos/cat.png", { thumbnail: 256 });
    const opened = await fetch(link.url);
    assert.equal(opened.status, 200);
    assert.equal(opened.headers.get("content-type"), "image/png");
    assert.deepEqual(new Uint8Array(await opened.arrayBuffer()), png);
    await assert.rejects(files.url("notes.txt", { thumbnail: 1024 }), (e: unknown) => e instanceof ChestError && e.code === "no_thumbnail" && e.status === 400);
    const download = await fetch((await files.url("notes.txt", { download: true })).url);
    assert.equal(download.headers.get("content-disposition"), `attachment; filename="notes.txt"`);
    assert.equal(await download.text(), "hello");
    // Changed since, the link opens nothing.
    const stale = await files.url("notes.txt");
    await files.put("notes.txt", "changed");
    assert.equal((await fetch(stale.url)).status, 404);
    // An upload into a folder: named by the Chest, its type and size checked, once.
    const up = await files.uploadUrl("photos/", { maxSize: 64, types: ["image/*"] });
    const sent = await fetch(up.url, { method: "PUT", body: png, headers: { "Content-Type": "image/png" } });
    assert.equal(sent.status, 201);
    const { name, type, size } = await sent.json() as { name: string; type: string; size: number };
    assert.match(name, /^photos\/[a-f0-9]{20}\.png$/u);
    assert.deepEqual([type, size], ["image/png", png.length]);
    assert.equal((await files.stat(name))?.sha256, createHash("sha256").update(png).digest("hex"));
    assert.equal((await fetch(up.url, { method: "PUT", body: png, headers: { "Content-Type": "image/png" } })).status, 403);
    const refusals: [{ types?: string[]; maxSize?: number }, Uint8Array<ArrayBuffer>, string, number, string][] = [
      [{ types: ["image/*"] }, png, "application/pdf", 415, "type_refused"],
      [{ types: ["image/*"] }, new Uint8Array([1, 2, 3]), "image/png", 400, "type_mismatch"],
      [{ maxSize: 4 }, png, "image/png", 413, "too_large"],
    ];
    for (const [grant, body, contentType, status, error] of refusals) {
      const one = await files.uploadUrl("upload.bin", grant);
      const answer = await fetch(one.url, { method: "PUT", body, headers: { "Content-Type": contentType } });
      assert.deepEqual([answer.status, (await answer.json() as { error: string }).error], [status, error]);
    }
    assert.equal(await files.stat("upload.bin"), null);
  } finally {
    await chest.close();
  }
});

test("its public part takes a visitor's upload of the type its content is, among those granted", async () => {
  const chest = await fakeChest({ capabilities: ["files"] });
  const pdf = new TextEncoder().encode("%PDF-1.7\n%%EOF\n");
  try {
    const up = await files.uploadUrl("applications/", { public: true, types: ["application/pdf"] });
    assert.match(up.url, /^\/_chest\/files\/upload\//u);
    // Whatever the browser says, the type is the content's.
    const sent = await fetch(new URL(up.url, chest.api), { method: "PUT", body: pdf, headers: { "Content-Type": "image/png" } });
    assert.equal(sent.status, 201);
    const { name, type } = await sent.json() as { name: string; type: string };
    assert.match(name, /^applications\/[a-f0-9]{20}\.pdf$/u);
    assert.equal(type, "application/pdf");
    assert.equal((await files.stat(name))?.type, "application/pdf");
    // A page that says it is a PDF is refused; a type not recognised by its content is never granted.
    const fake = await files.uploadUrl("applications/", { public: true, types: ["application/pdf"] });
    const refused = await fetch(new URL(fake.url, chest.api), { method: "PUT", body: "<html></html>", headers: { "Content-Type": "application/pdf" } });
    assert.deepEqual([refused.status, (await refused.json() as { error: string }).error], [415, "type_refused"]);
    await assert.rejects(files.uploadUrl("applications/", { public: true, types: ["text/plain"] }), (e: unknown) => e instanceof ChestError && e.code === "invalid_type");
  } finally {
    await chest.close();
  }
  // A tool without a public part grants none.
  const closed = await fakeChest({ capabilities: ["files"], chest: { publicUrl: null } });
  try {
    await assert.rejects(files.uploadUrl("applications/", { public: true, types: ["application/pdf"] }), (e: unknown) => e instanceof ChestError && e.code === "no_public_part" && e.status === 409);
  } finally {
    await closed.close();
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

test("its notifications are never refused for their pace: a burst is folded into one item, nothing lost", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_790_000_000_000 });
  const many = Array.from({ length: 500 }, (_, i) => ({ ...zoe, id: id("m" + String.fromCharCode(97 + (i % 26), 97 + Math.floor(i / 26))) }));
  const chest = await fakeChest({ members: [camille, ...many] });
  try {
    const ids = many.map(m => m.id);
    // The whole team of 501 at once, over and over: ten items each, the
    // rest folded into one grouped item each, showing the latest.
    for (let i = 0; i < 37; i++) assert.deepEqual((await notifications.notify([camille.id, ...ids], { title: "Order " + i })).skipped, []);
    const camilles = chest.notifications.filter(n => n.member === camille.id);
    assert.equal(camilles.length, 11);
    assert.deepEqual(camilles.at(-1), { member: camille.id, title: "Order 36", path: "/chest", grouped: 27 });
    assert.equal(chest.notifications.length, 501 * 11);
    // A replacement by key is never folded; after six minutes, an item again.
    await notifications.notify([camille.id], { title: "Pinned", key: "pin" });
    assert.equal(chest.notifications.at(-1)?.grouped, 28);
    mock.timers.setTime(1_790_000_000_000 + 6 * 60_000);
    await notifications.notify([camille.id], { title: "Pinned", key: "pin" });
    await notifications.notify([camille.id], { title: "Pinned again", key: "pin" });
    assert.deepEqual(chest.notifications.filter(n => n.key === "pin"), [{ member: camille.id, title: "Pinned again", path: "/chest", key: "pin" }]);
    // Badges, a state: the last write wins, none refused.
    for (let i = 0; i < 20; i++) await notifications.badge.setMany(ids.map(memberId => ({ memberId, count: i + 1 })));
    assert.equal(await notifications.badge.set(camille.id, 1), true);
    assert.equal(chest.badges.get(ids[0]!), 20);
  } finally {
    await chest.close();
    mock.timers.reset();
  }
});

test("its AI answers deterministically, streamed or not, and keeps the calls", async () => {
  const chest = await fakeChest();
  try {
    const messages: ai.ChatMessage[] = [{ role: "system", content: "Be brief." }, { role: "user", content: "Hello there, Chest" }];
    const r = await ai.chat({ model: "default", messages, member: camille.id });
    assert.deepEqual([r.text, r.model, r.finishReason, r.toolCalls], ["Hello there, Chest", "fake-default", "stop", []]);
    assert.ok(r.usage.input > 0 && r.usage.output > 0 && r.usage.cost > 0);
    const pieces: ai.ChatChunk[] = [];
    for await (const piece of ai.chat({ model: "fast", messages, stream: true })) pieces.push(piece);
    assert.equal(pieces.map(p => p.text).join(""), "Hello there, Chest");
    assert.equal(pieces.at(-2)?.finishReason, "stop");
    assert.deepEqual(pieces.at(-1)?.usage, r.usage);
    assert.deepEqual(chest.ai.map(c => c.path), ["/ai/chat", "/ai/chat"]);
    assert.deepEqual(chest.ai[0]?.body, { model: "default", messages, member: camille.id });

    const one = await ai.embed({ model: "embedding", input: ["a", "b", "a"] });
    assert.equal(one.model, "fake-embedding");
    assert.equal(one.embeddings[0]?.length, 8);
    assert.deepEqual(one.embeddings[0], one.embeddings[2]);
    assert.notDeepEqual(one.embeddings[0], one.embeddings[1]);
    assert.ok(Math.abs(Math.hypot(...one.embeddings[1]!) - 1) < 1e-9);
    assert.equal((await ai.embed({ model: "embedding", input: "a", dimensions: 100 })).embeddings[0]?.length, 100);

    assert.deepEqual((await ai.models()).map(m => [m.alias, m.model, m.provider]), [["default", "fake-default", "openrouter"], ["fast", "fake-fast", "openrouter"], ["smart", "fake-smart", "openrouter"], ["embedding", "fake-embedding", "openrouter"]]);
    const month = await ai.usage();
    assert.equal(month.cap, 5);
    assert.equal(month.month, new Date().toISOString().slice(0, 7));
    assert.ok(month.spent > 0 && month.resetsAt > new Date());
    const raw = await fetch(chest.api + "/ai/chat", { method: "POST", body: JSON.stringify({ model: "default", messages, n: 2 }) });
    assert.deepEqual([raw.status, await raw.json()], [400, { error: "invalid_body" }]);
  } finally {
    await chest.close();
  }
});

test("its AI answers what reply says, tool calls too, streamed in pieces", async () => {
  const asked: unknown[] = [];
  const chest = await fakeChest({ ai: { reply: request => { asked.push(request["tools"]); return { toolCalls: [{ name: "lookup", arguments: "{\"id\":\"42\"}" }] }; } } });
  try {
    const tools: ai.ChatTool[] = [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }];
    const r = await ai.chat({ model: "smart", messages: [{ role: "user", content: "Task 42?" }], tools });
    assert.deepEqual([r.text, r.finishReason, r.toolCalls], ["", "tool_calls", [{ id: "call_1", name: "lookup", arguments: "{\"id\":\"42\"}" }]]);
    assert.deepEqual(r.message, { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"id\":\"42\"}" } }] });
    assert.deepEqual(asked, [tools]);
    const calls: { id?: string; name?: string; arguments: string }[] = [];
    for await (const piece of ai.chat({ model: "smart", messages: [{ role: "user", content: "Task 42?" }], stream: true })) {
      for (const d of piece.toolCalls ?? []) {
        const call = calls[d.index] ??= { arguments: "" };
        if (d.id) call.id = d.id;
        if (d.name) call.name = d.name;
        call.arguments += d.arguments ?? "";
      }
    }
    assert.deepEqual(calls, [{ id: "call_1", name: "lookup", arguments: "{\"id\":\"42\"}" }]);
  } finally {
    await chest.close();
  }
});

test("its AI refuses as the Chest's: undeclared model, cap, connector, capability, rate", async () => {
  const chest = await fakeChest({ ai: { models: [{ alias: "default", model: "m", input: 1_000_000, output: 1_000_000 }], cap: 1 } });
  try {
    await assert.rejects(ai.chat({ model: "fast", messages: [{ role: "user", content: "a" }] }), AiModelNotAllowed);
    assert.deepEqual((await ai.models()).map(m => m.alias), ["default"]);
    // Each call costs a euro a token: the first spends the cap, the next is refused.
    await ai.chat({ model: "default", messages: [{ role: "user", content: "a" }] });
    await assert.rejects(ai.chat({ model: "default", messages: [{ role: "user", content: "a" }] }), (e: unknown) => e instanceof AiCapReached && e.scope === "tool" && e.resetsAt > new Date());
    const month = await ai.usage();
    assert.ok(month.spent >= month.cap);
  } finally {
    await chest.close();
  }
  for (const reason of ["no_connector", "provider_key_invalid", "provider_unavailable"] as const) {
    const down = await fakeChest({ ai: { unavailable: reason } });
    try {
      await assert.rejects(ai.chat({ model: "default", messages: [{ role: "user", content: "a" }] }), (e: unknown) => e instanceof AiUnavailable && e.reason === reason);
      await assert.rejects(ai.embed({ model: "embedding", input: "a" }), AiUnavailable);
    } finally {
      await down.close();
    }
  }
  const spent = await fakeChest({ ai: { cap: 0 } });
  try {
    await assert.rejects(ai.embed({ model: "embedding", input: "a" }), AiCapReached);
  } finally {
    await spent.close();
  }
  const without = await fakeChest({ capabilities: ["members"] });
  try {
    await assert.rejects(ai.chat({ model: "default", messages: [{ role: "user", content: "a" }] }), CapabilityNotGranted);
    assert.equal(without.ai.length, 1);
  } finally {
    await without.close();
  }
  const busy = await fakeChest();
  try {
    for (let i = 0; i < 60; i++) await ai.embed({ model: "embedding", input: "a" });
    await assert.rejects(ai.embed({ model: "embedding", input: "a" }), RateLimited);
  } finally {
    await busy.close();
  }
});
