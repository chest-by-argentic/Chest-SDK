import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { CapabilityNotGranted, ChestError, TooLarge } from "../src/errors.js";
import type { Member } from "../src/member.js";
import * as realtime from "../src/realtime.js";
import { connect, type ClosedReason, type Live, type Present } from "../src/realtime-client.js";
import { fakeChest, type FakeChest } from "../src/testing.js";

// The server module against a fake Chest's API, and the browser client
// against its hub: the protocol the Chest speaks (chest/realtime), its
// rules, its replays and its closes. The page's timers are mocked for the
// whole file — minutes pass on mock.timers.tick, a page away stays away
// until the test moves its clock —, the Chest's clock is its own (advance).
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
// The page's sockets as a test sees them: what each sent and heard, and
// whether it closed (seen once the client handled it). A deaf one hears
// nothing more, as on a network that died silently.
class Recorded extends WebSocket {
  sent: Record<string, unknown>[] = [];
  heard: Record<string, unknown>[] = [];
  closed = false;
  deaf = false;
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    sockets.push(this);
    this.addEventListener("close", () => { this.closed = true; });
    this.addEventListener("message", event => {
      if (this.deaf) return event.stopImmediatePropagation();
      this.heard.push(JSON.parse(String(event.data)) as Record<string, unknown>);
    });
  }
  override send(data: Parameters<WebSocket["send"]>[0]): void {
    this.sent.push(JSON.parse(String(data)) as Record<string, unknown>);
    super.send(data);
  }
  // answered: every ping it sent was answered.
  get answered(): boolean {
    return this.sent.every(m => m["op"] !== "ping" || this.heard.some(h => h["ref"] === m["ref"]));
  }
}
const sockets: Recorded[] = [];
globalThis.WebSocket = Recorded;
// The real timers, kept from the mocks (enabled once: a timer of the
// runtime made under one mock must not meet another).
const realTimeout = globalThis.setTimeout;
mock.timers.enable({ apis: ["setTimeout", "setInterval"] });

let chest: FakeChest | undefined;
const lives: Live[] = [];
afterEach(async () => {
  for (const live of lives.splice(0)) live.close();
  await chest?.close();
  chest = undefined;
  sockets.length = 0;
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
  for (let i = 0; i < 300 && !ok(); i++) await new Promise(resolve => realTimeout(resolve, 10));
  assert.ok(ok(), what);
};
// elapse moves the page's mocked clock forward, 5 s at a time, each ping
// answered before the next step (as on a live network).
const elapse = async (ms: number) => {
  for (let done = 0; done < ms; done += 5000) {
    mock.timers.tick(Math.min(5000, ms - done));
    const socket = sockets.at(-1);
    await until("pings answered", () => !socket || socket.readyState !== WebSocket.OPEN || socket.answered);
  }
};
const minutes = 60 * 1000;
// away cuts the member's page, as a network would; back lets its first
// wait pass (under 0.5 s after a connection that held).
const away = async (c: FakeChest, member: Member) => {
  c.realtime.drop(member.id);
  await until("the cut seen", () => sockets.at(-1)!.closed);
};
const back = () => mock.timers.tick(500);
// heard listens to a channel's rows (their ids) and notes, its joins and resyncs.
const listen = (live: Live, name: string) => {
  const room = live.channel(name), heard: unknown[] = [], joins: unknown[] = [];
  let resyncs = 0;
  room.on("messages.insert", row => heard.push((row as { id: number }).id));
  room.on("note", payload => heard.push(payload));
  room.on("joined", joined => joins.push(joined));
  room.on("resync", () => resyncs++);
  return { room, heard, joins, resyncs: () => resyncs };
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

test("a page back within 2 minutes is replayed what it missed from the memory, a row given twice heard once; access removed stops it", async () => {
  const c = await start();
  const b = open(c, dan);
  const ends: ClosedReason[] = [];
  b.on("closed", reason => ends.push(reason));
  const { heard, joins, resyncs } = listen(b, "room:42");
  await until("joined", () => joins.length === 1);
  c.realtime.commit("messages", "insert", { id: 1, room_id: 42 });
  await until("first row", () => heard.length === 1);
  await away(c, dan);
  await realtime.publish("room:42", "note", "away");
  c.realtime.commit("messages", "insert", { id: 2, room_id: 42 });
  c.realtime.advance(1 * minutes);
  c.realtime.commit("messages", "insert", { id: 3, room_id: 42 });
  back();
  await until("replayed after reconnecting", () => heard.length === 4);
  assert.deepEqual(heard, [1, "away", 2, 3]);
  assert.deepEqual(joins, [{ replayed: false }, { replayed: true }]);
  // A row given again (a replay racing a live commit) is heard once.
  sockets.at(-1)!.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ op: "msg", ch: "room:42", event: "messages.insert", payload: { id: 3, room_id: 42 }, pos: 3 }) }));
  c.realtime.commit("messages", "insert", { id: 4, room_id: 42 });
  await until("the next row", () => heard.length === 5);
  assert.deepEqual(heard, [1, "away", 2, 3, 4]);
  assert.equal(resyncs(), 0);
  c.realtime.revoke(dan.id);
  await until("closed for good", () => ends.length === 1);
  assert.deepEqual(ends, ["access_removed"]);
});

test("a page away 10 minutes is given every row it missed from the change log, once and in order, without a reload", async () => {
  const c = await start();
  const b = open(c, dan);
  const { heard, joins, resyncs } = listen(b, "room:42");
  await until("joined", () => joins.length === 1);
  c.realtime.commit("messages", "insert", { id: 1, room_id: 42 });
  c.realtime.commit("messages", "insert", { id: 2, room_id: 42 });
  await until("the first rows", () => heard.length === 2);
  await away(c, dan);
  await realtime.publish("room:42", "note", "away");
  c.realtime.commit("messages", "insert", { id: 3, room_id: 42 });
  c.realtime.advance(10 * minutes);
  c.realtime.commit("messages", "insert", { id: 4, room_id: 42 });
  c.realtime.commit("messages", "insert", { id: 5, room_id: 42 });
  back();
  await until("joined again", () => joins.length === 2);
  await realtime.publish("room:42", "note", "live");
  c.realtime.commit("messages", "insert", { id: 6, room_id: 42 });
  await until("the live row", () => heard.includes(6));
  // Every row once, in order; the tool's event of 10 minutes ago is not
  // kept (an event is a hint), the live one comes.
  assert.deepEqual(heard, [1, 2, 3, 4, 5, "live", 6]);
  assert.deepEqual(joins, [{ replayed: false }, { replayed: true }]);
  assert.equal(resyncs(), 0);
});

test("a page away beyond the change log's 7 days is told resync", async () => {
  const c = await start();
  const b = open(c, dan);
  const { heard, joins, resyncs } = listen(b, "room:42");
  await until("joined", () => joins.length === 1);
  c.realtime.commit("messages", "insert", { id: 1, room_id: 42 });
  await until("the first row", () => heard.length === 1);
  await away(c, dan);
  c.realtime.commit("messages", "insert", { id: 2, room_id: 42 });
  c.realtime.advance(8 * 24 * 60 * minutes);
  back();
  await until("joined again", () => joins.length === 2);
  assert.deepEqual(joins, [{ replayed: false }, { replayed: false }]);
  assert.equal(resyncs(), 1);
  c.realtime.commit("messages", "insert", { id: 3, room_id: 42 });
  await until("the next row", () => heard.length === 2);
  assert.deepEqual(heard, [1, 3]);
});

test("the session is renewed every 5 minutes while connected; signed out, the page stops", async () => {
  const c = await start();
  const b = open(c, dan);
  const statuses: boolean[] = [], ends: ClosedReason[] = [];
  b.on("status", connected => statuses.push(connected));
  b.on("closed", reason => ends.push(reason));
  const { joins } = listen(b, "room:42");
  await until("joined", () => joins.length === 1);
  await elapse(4 * minutes);
  assert.equal(c.realtime.renewals, 0);
  await elapse(1 * minutes);
  await until("renewed", () => c.realtime.renewals === 1);
  await elapse(5 * minutes);
  await until("renewed again", () => c.realtime.renewals === 2);
  c.realtime.signOut(dan.id);
  await elapse(5 * minutes);
  await until("signed out", () => ends.length === 1);
  assert.deepEqual(ends, ["signed_out"]);
  assert.deepEqual(statuses, [true]);
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0]!.readyState, WebSocket.CLOSED);
});

test("a full Chest is waited for quietly, as long as it asks", async () => {
  const c = await start();
  const b = open(c, dan);
  const statuses: boolean[] = [], ends: ClosedReason[] = [];
  b.on("status", connected => statuses.push(connected));
  b.on("closed", reason => ends.push(reason));
  const { joins } = listen(b, "room:42");
  await until("joined", () => joins.length === 1);
  c.realtime.full(10);
  await away(c, dan);
  await elapse(500);
  await until("asked", () => c.realtime.renewals === 1);
  await elapse(2400);
  assert.deepEqual(statuses, [true]);
  await elapse(200);
  assert.deepEqual(statuses, [true, false]);
  assert.equal(sockets.length, 1);
  c.realtime.advance(10 * 1000);
  for (let i = 0; i < 60 && joins.length < 2; i++) {
    mock.timers.tick(1000);
    await new Promise(resolve => realTimeout(resolve, 10));
  }
  await until("connected again", () => joins.length === 2);
  assert.deepEqual(statuses, [true, false, true]);
  assert.deepEqual(ends, []);
  assert.equal(c.realtime.renewals, 2);
});

test("a quick reconnect is not told: a cut, going away, try later, a session to renew", async () => {
  const c = await start();
  const b = open(c, dan);
  const statuses: boolean[] = [], ends: ClosedReason[] = [];
  b.on("status", connected => statuses.push(connected));
  b.on("closed", reason => ends.push(reason));
  const { joins } = listen(b, "room:42");
  await until("joined", () => joins.length === 1);
  const closes: [number?, string?][] = [[], [1001, "going_away"], [1013, "try_later"], [1008, "session_ended"]];
  for (const [i, [code, reason]] of closes.entries()) {
    c.realtime.drop(dan.id, code, reason);
    await until("the close seen", () => sockets.at(-1)!.closed);
    back();
    await until("joined again", () => joins.length === i + 2);
  }
  await elapse(10 * 1000);
  assert.deepEqual(statuses, [true]);
  assert.deepEqual(ends, []);
  assert.equal(sockets.length, 5);
});

test("a page back in the foreground, on the network or from the cache reconnects at once; offline, it drops its connection and waits", async () => {
  // The browser, as the client sees it: the window, its document, its navigator.
  const target = () => {
    const listeners = new Map<string, Set<(event: unknown) => void>>();
    return {
      listeners,
      addEventListener: (type: string, listener: (event: unknown) => void) => { listeners.set(type, (listeners.get(type) ?? new Set()).add(listener)); },
      removeEventListener: (type: string, listener: (event: unknown) => void) => { listeners.get(type)?.delete(listener); },
      dispatch: (type: string, event: unknown = {}) => { for (const listener of listeners.get(type) ?? []) listener(event); },
    };
  };
  const window = target(), document = { ...target(), visibilityState: "visible" }, navigator = { onLine: true };
  const page = globalThis as unknown as Record<string, unknown>, saved = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.assign(page, { addEventListener: window.addEventListener, removeEventListener: window.removeEventListener, document });
  Object.defineProperty(globalThis, "navigator", { value: navigator, configurable: true, writable: true });
  try {
    const c = await start();
    const b = open(c, dan);
    const statuses: boolean[] = [];
    b.on("status", connected => statuses.push(connected));
    const { joins } = listen(b, "room:42");
    await until("joined", () => joins.length === 1);
    // Back in the foreground: a ping; answered, nothing more.
    document.dispatch("visibilitychange");
    await until("pinged and answered", () => sockets[0]!.sent.some(m => m["op"] === "ping") && sockets[0]!.answered);
    await elapse(10 * 1000);
    assert.equal(sockets.length, 1);
    // Unanswered within 5 s (the network died silently): another at once.
    sockets[0]!.deaf = true;
    document.dispatch("visibilitychange");
    await elapse(5 * 1000);
    await until("joined again", () => joins.length === 2);
    // Offline: the connection dropped at once, no attempt however long;
    // online: at once.
    navigator.onLine = false;
    window.dispatch("offline");
    await until("dropped", () => sockets[1]!.closed);
    const asked = c.realtime.renewals;
    await elapse(10 * minutes);
    assert.equal(sockets.length, 2);
    assert.equal(c.realtime.renewals, asked);
    navigator.onLine = true;
    window.dispatch("online");
    await until("joined at once", () => joins.length === 3);
    // Restored from the cache: at once, without waiting the backoff.
    await away(c, dan);
    window.dispatch("pageshow", { persisted: true });
    await until("joined at once", () => joins.length === 4);
    assert.deepEqual(statuses, [true, false, true]);
    b.close();
    assert.deepEqual([...window.listeners.values(), ...document.listeners.values()].map(set => set.size), [0, 0, 0, 0]);
  } finally {
    delete page["addEventListener"];
    delete page["removeEventListener"];
    delete page["document"];
    if (saved) Object.defineProperty(globalThis, "navigator", saved);
    else delete page["navigator"];
  }
});
