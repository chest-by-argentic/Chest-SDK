import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { CapabilityNotGranted, ChestError, TooLarge } from "../src/errors.js";
import type { Member } from "../src/member.js";
import * as realtime from "../src/realtime.js";
import { connect, type ClosedReason, type Live, type Present } from "../src/realtime-client.js";
import { fakeChest, type FakeChest } from "../src/testing.js";

// The server module against a fake Chest's API, and the browser client
// against its hub: the protocol the Chest speaks (chest/realtime), its
// rules, its replays and its closes.
const person = (name: string, role: string | null = null): Member => ({ id: "mbr_" + name + "a".repeat(26 - name.length), firstName: name, lastName: "Test", name: name + " Test", photo: null, role, isAdmin: false, isBuilder: false, groups: [], language: "en", timeZone: "UTC" });
const camille = person("camille", "manager"), dan = person("dan", "member");

const rules = {
  channels: [
    { name: "everyone", presence: true, send: true },
    { name: "room:{id}", join: { table: "room_members", key: "room_id", member: "member_id" }, send: true, presence: true },
    { name: "inbox:{member}" },
    { name: "desk", join: ["manager"] },
  ],
  feeds: [{ table: "messages", channel: "room:{room_id}", columns: ["id", "room_id", "text"] }],
};
const rooms = new Map([["42", [camille.id, dan.id]]]);
let chest: FakeChest | undefined;
const lives: Live[] = [];
afterEach(async () => {
  for (const live of lives.splice(0)) live.close();
  await chest?.close();
  chest = undefined;
});
const start = async (capabilities = ["members", "realtime"]) => {
  chest = await fakeChest({ members: [camille, dan], capabilities, realtime: { ...rules, membership: (table, key, member) => table === "room_members" && (rooms.get(key) ?? []).includes(member) } });
  return chest;
};
const open = (c: FakeChest, member: Member): Live => {
  const live = connect({ url: c.realtime.url(member.id) });
  lives.push(live);
  return live;
};
// until waits for a condition, a few seconds at most.
const until = async (what: string, ok: () => boolean) => {
  for (let i = 0; i < 300 && !ok(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(ok(), what);
};

test("publish, send, online and presence answer as the Chest does, and refuse what it refuses", async () => {
  const c = await start();
  assert.deepEqual(await realtime.publish("everyone", "rooms.changed", { id: 7 }), { seq: 1 });
  assert.deepEqual(await realtime.publish("inbox:" + dan.id, "hello"), { seq: 1 });
  assert.deepEqual(c.realtime.published, [{ channel: "everyone", event: "rooms.changed", payload: { id: 7 }, seq: 1 }, { channel: "inbox:" + dan.id, event: "hello", payload: null, seq: 1 }]);
  assert.deepEqual(await realtime.send([dan.id], "unread", { count: 3 }), { reached: [] });
  assert.deepEqual(await realtime.online([camille.id, dan.id]), { online: [] });
  assert.deepEqual(await realtime.presence("everyone"), { members: [] });
  const code = (expected: string) => (error: unknown) => error instanceof ChestError && error.code === expected;
  await assert.rejects(realtime.publish("nowhere", "x"), code("invalid_channel"));
  await assert.rejects(realtime.publish("Room:1", "x"), code("invalid_channel"));
  await assert.rejects(realtime.publish("everyone", "Bad"), code("invalid_event"));
  await assert.rejects(realtime.publish("everyone", "big", "x".repeat(64 << 10)), TooLarge);
  await assert.rejects(realtime.send([], "x"), code("invalid_body"));
  await assert.rejects(realtime.send(["camille"], "x"), code("invalid_id"));
  await c.close();
  chest = undefined;
  await start(["members"]);
  await assert.rejects(realtime.publish("everyone", "x"), CapabilityNotGranted);
});

test("two members chat: rows of a feed, ephemeral sends with their sender, presence, direct events", async () => {
  const c = await start();
  const a = open(c, camille), b = open(c, dan);
  const roomA = a.channel("room:42"), roomB = b.channel("room:42");
  const rowsA: unknown[] = [], rowsB: unknown[] = [], typing: (string | undefined)[] = [];
  let joined = 0;
  for (const room of [roomA, roomB]) room.on("joined", () => joined++);
  roomA.on("messages.insert", row => rowsA.push(row));
  roomB.on("messages.insert", row => rowsB.push(row));
  roomB.on("typing", (_, from) => typing.push(from));
  await until("both joined", () => joined === 2);
  assert.deepEqual([a.member, b.member], [camille.id, dan.id]);
  assert.equal(c.realtime.commit("messages", "insert", { id: 1, room_id: 42, text: "hello", secret: "s" }), 1);
  await until("the row reached both", () => rowsA.length === 1 && rowsB.length === 1);
  assert.deepEqual(rowsB, [{ id: 1, room_id: 42, text: "hello" }]);
  roomA.send("typing");
  await until("typing told", () => typing.length === 1);
  assert.deepEqual(typing, [camille.id]);
  const seen: Present[][] = [];
  roomB.presence.on(list => seen.push(list));
  roomA.presence.track({ active: true });
  await until("presence told", () => seen.some(list => list.some(p => p.id === camille.id)));
  assert.deepEqual((await realtime.presence("room:42")).members, [{ id: camille.id, state: { active: true } }]);
  const direct: [string, unknown][] = [];
  b.on("direct", (event, payload) => direct.push([event, payload]));
  assert.deepEqual(await realtime.send([dan.id], "unread", { count: 2 }), { reached: [dan.id] });
  await until("direct", () => direct.length === 1);
  assert.deepEqual(direct, [["unread", { count: 2 }]]);
  assert.deepEqual((await realtime.online([camille.id, dan.id])).online, [camille.id, dan.id]);
  // The rules: the desk for its role only, a lane of one's own only.
  const refused: unknown[] = [];
  b.channel("desk").on("refused", code => refused.push(code));
  b.channel("inbox:" + camille.id).on("refused", code => refused.push(code));
  const deskA: unknown[] = [];
  const desk = a.channel("desk");
  desk.on("note", payload => deskA.push(payload));
  let deskJoined = false;
  desk.on("joined", () => { deskJoined = true; });
  await until("refused twice, the desk joined", () => refused.length === 2 && deskJoined);
  assert.deepEqual(refused.sort(), ["forbidden", "invalid_channel"]);
  await realtime.publish("desk", "note", "for managers");
  await until("the manager hears the desk", () => deskA.length === 1);
});

test("a membership row that goes takes its member out at once", async () => {
  const c = await start();
  const b = open(c, dan);
  const room = b.channel("room:42"), inbox = b.channel("inbox:" + dan.id);
  const events: string[] = [];
  for (const [channel, name] of [[room, "room"], [inbox, "inbox"]] as const) {
    channel.on("joined", () => events.push(name + " joined"));
    channel.on("kicked", () => events.push(name + " kicked"));
  }
  room.on("messages.insert", () => events.push("row"));
  inbox.on("note", () => events.push("note"));
  await until("joined", () => events.length === 2);
  c.realtime.removed("room_members", "42", dan.id);
  await until("kicked", () => events.includes("room kicked"));
  c.realtime.commit("messages", "insert", { id: 2, room_id: 42, text: "after" });
  // What the tool publishes next reaches the page: the row before it did not.
  await realtime.publish("inbox:" + dan.id, "note");
  await until("the note", () => events.includes("note"));
  assert.deepEqual(events.slice(2), ["room kicked", "note"]);
});

test("a page that reconnects is replayed what it missed; access removed stops it for good", async () => {
  const c = await start();
  const b = open(c, dan);
  const rows: number[] = [], statuses: boolean[] = [], ends: ClosedReason[] = [];
  b.on("status", connected => statuses.push(connected));
  b.on("closed", reason => ends.push(reason));
  const room = b.channel("room:42");
  room.on("messages.insert", row => rows.push((row as { id: number }).id));
  const joins: unknown[] = [];
  room.on("joined", payload => joins.push(payload));
  await until("joined", () => joins.length === 1);
  c.realtime.commit("messages", "insert", { id: 1, room_id: 42 });
  await until("first row", () => rows.length === 1);
  c.realtime.drop(dan.id);
  await until("disconnected", () => statuses.includes(false));
  c.realtime.commit("messages", "insert", { id: 2, room_id: 42 });
  c.realtime.commit("messages", "insert", { id: 3, room_id: 42 });
  await until("replayed after reconnecting", () => rows.length === 3);
  assert.deepEqual(rows, [1, 2, 3]);
  assert.deepEqual(joins, [{ replayed: false }, { replayed: true }]);
  c.realtime.revoke(dan.id);
  await until("closed for good", () => ends.length === 1);
  assert.deepEqual(ends, ["access_removed"]);
});
