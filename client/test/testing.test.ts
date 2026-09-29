import assert from "node:assert/strict";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { mock, test } from "node:test";
import * as ai from "../src/ai.js";
import { AiCapReached, AiModelNotAllowed, AiUnavailable, CapabilityNotGranted, ChestError, QuotaExceeded, RateLimited, TooLarge } from "../src/errors.js";
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
    assert.deepEqual([theChest.organization.name, theChest.timeZone, theChest.language], ["Test organization", "UTC", "en"]);
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
