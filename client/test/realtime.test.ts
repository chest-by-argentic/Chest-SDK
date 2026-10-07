import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { CapabilityNotGranted, ChestError, TooLarge } from "../src/errors.js";
import type { Member } from "../src/member.js";
import * as realtime from "../src/realtime.js";
import { connect, type ClosedReason, type EventInfo, type Live, type Present } from "../src/realtime-client.js";
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
const start = async (capabilities = ["members", "realtime"], feeds = rules.feeds) => {
  chest = await fakeChest({ members: [camille, dan], capabilities, realtime: { ...rules, feeds, membership: (table, key, member) => table === "room_members" && (rooms.get(key) ?? []).includes(member) } });
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
// waitOut lets the page's clock run, a second at a time, until a condition.
const waitOut = async (what: string, ok: () => boolean) => {
  for (let i = 0; i < 60 && !ok(); i++) {
    mock.timers.tick(1000);
    await new Promise(resolve => realTimeout(resolve, 10));
  }
  assert.ok(ok(), what);
};
// heard listens to a channel's rows (their ids) and notes, its joins and resyncs.
const listen = (live: Live, name: string) => {
  const room = live.channel(name), heard: unknown[] = [], joins: unknown[] = [];
  let resyncs = 0;
  room.on("messages.insert", row => heard.push((row as { id: number }).id));
  room.on("note", payload => heard.push(payload));
  room.onJoined(joined => joins.push(joined));
  room.onResync(() => resyncs++);
  return { room, heard, joins, resyncs: () => resyncs };
};

test("publish, send, online and presence answer as the Chest does, and refuse what it refuses", async () => {
  const c = await start();
  assert.deepEqual(await realtime.publish("everyone", "rooms.changed", { id: 7 }), { seq: 1 });
  assert.deepEqual(await realtime.publish("inbox:" + dan.id, "hello"), { seq: 1 });
  assert.deepEqual(c.realtime.published, [{ channel: "everyone", event: "rooms.changed", payload: { id: 7 }, seq: 1 }, { channel: "inbox:" + dan.id, event: "hello", payload: null, seq: 1 }]);
  assert.deepEqual(await realtime.send([dan.id], "unread", { count: 3 }), { reached: [] });
  assert.deepEqual(await realtime.online([camille.id, dan.id]), { online: [], watching: [] });
  assert.deepEqual(await realtime.online([camille.id], { channel: "room:42" }), { online: [], watching: [] });
  assert.deepEqual(await realtime.presence("everyone"), { members: [] });
  const code = (expected: string) => (error: unknown) => error instanceof ChestError && error.code === expected;
  await assert.rejects(realtime.publish("nowhere", "x"), code("invalid_channel"));
  await assert.rejects(realtime.publish("Room:1", "x"), code("invalid_channel"));
  await assert.rejects(realtime.publish("everyone", "Bad"), code("invalid_event"));
  await assert.rejects(realtime.publish("everyone", "big", "x".repeat(64 << 10)), TooLarge);
  await assert.rejects(realtime.send([], "x"), code("invalid_body"));
  await assert.rejects(realtime.send(["camille"], "x"), code("invalid_id"));
  await assert.rejects(realtime.online([dan.id], { channel: "Room:1" }), code("invalid_channel"));
  await c.close();
  chest = undefined;
  await start(["members"]);
  await assert.rejects(realtime.publish("everyone", "x"), CapabilityNotGranted);
});

test("two members chat: rows of a feed, ephemeral sends with their sender, presence, direct events", async () => {
  const c = await start();
  const a = open(c, camille), b = open(c, dan);
  const roomA = a.channel("room:42"), roomB = b.channel("room:42");
  const rowsA: unknown[] = [], rowsB: [unknown, EventInfo][] = [], typing: string[] = [];
  let joined = 0;
  for (const room of [roomA, roomB]) room.onJoined(() => joined++);
  roomA.on("messages.insert", row => rowsA.push(row));
  roomB.on("messages.insert", (row, info) => rowsB.push([row, info]));
  roomB.peers.on("typing", (_, from) => typing.push(from));
  await until("both joined", () => joined === 2);
  assert.deepEqual([a.member, b.member], [camille.id, dan.id]);
  assert.deepEqual(c.realtime.commit("messages", "insert", { id: 1, room_id: 42, text: "hello", secret: "s" }), [1]);
  await until("the row reached both", () => rowsA.length === 1 && rowsB.length === 1);
  assert.deepEqual(rowsB, [[{ id: 1, room_id: 42, text: "hello" }, { pos: 1 }]]);
  roomA.peers.send("typing");
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
  const refused: string[] = [];
  b.channel("desk").onRefused(code => refused.push(code));
  b.channel("inbox:" + camille.id).onRefused(code => refused.push(code));
  const deskA: unknown[] = [];
  const desk = a.channel("desk");
  desk.on("note", payload => deskA.push(payload));
  let deskJoined = false;
  desk.onJoined(() => { deskJoined = true; });
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
    channel.onJoined(() => events.push(name + " joined"));
    channel.onKicked(() => events.push(name + " kicked"));
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
  await waitOut("connected again", () => joins.length === 2);
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

// browser plays the browser around the client — the window, its document,
// its navigator — for the time of run.
const browser = async (run: (window: Target, document: Target & { visibilityState: string }, navigator: { onLine: boolean }) => Promise<void>) => {
  const window = target(), document = { ...target(), visibilityState: "visible" }, navigator = { onLine: true };
  const page = globalThis as unknown as Record<string, unknown>, saved = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.assign(page, { addEventListener: window.addEventListener, removeEventListener: window.removeEventListener, document });
  Object.defineProperty(globalThis, "navigator", { value: navigator, configurable: true, writable: true });
  try {
    await run(window, document, navigator);
  } finally {
    delete page["addEventListener"];
    delete page["removeEventListener"];
    delete page["document"];
    if (saved) Object.defineProperty(globalThis, "navigator", saved);
    else delete page["navigator"];
  }
};
type Target = ReturnType<typeof target>;
const target = () => {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  return {
    listeners,
    addEventListener: (type: string, listener: (event: unknown) => void) => { listeners.set(type, (listeners.get(type) ?? new Set()).add(listener)); },
    removeEventListener: (type: string, listener: (event: unknown) => void) => { listeners.get(type)?.delete(listener); },
    dispatch: (type: string, event: unknown = {}) => { for (const listener of listeners.get(type) ?? []) listener(event); },
  };
};

test("a page back in the foreground, on the network or from the cache reconnects at once; offline, it drops its connection and waits", () => browser(async (window, document, navigator) => {
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
}));

test("a member's message comes through peers with its sender, never as the Chest's event; a dotted name is refused", async () => {
  const c = await start();
  const a = open(c, camille), b = open(c, dan);
  const roomA = listen(a, "room:42"), roomB = listen(b, "room:42");
  const peers: [string, unknown, string][] = [];
  for (const event of ["note", "messages_insert"]) roomB.room.peers.on(event, (payload, from) => peers.push([event, payload, from]));
  roomB.room.on("messages_insert", payload => roomB.heard.push(payload));
  await until("both joined", () => roomA.joins.length === 1 && roomB.joins.length === 1);
  // Named as the tool's event, or as a feed's without its dot: a peer.
  roomA.room.peers.send("note", "from camille");
  roomA.room.peers.send("messages_insert", { id: 9 });
  await realtime.publish("room:42", "note", "from the tool");
  await until("all heard", () => peers.length === 2 && roomB.heard.length === 1);
  assert.deepEqual(peers, [["note", "from camille", camille.id], ["messages_insert", { id: 9 }, camille.id]]);
  assert.deepEqual(roomB.heard, ["from the tool"]);
  // A dotted name, refused by the client before it leaves, and by the Chest.
  assert.throws(() => roomA.room.peers.send("messages.insert", { id: 10 }), /^TypeError: invalid_event/u);
  assert.throws(() => roomA.room.peers.send("Typing"), /^TypeError: invalid_event/u);
  const socket = sockets.find(s => s.heard[0]?.["member"] === camille.id)!;
  socket.send(JSON.stringify({ op: "send", ref: 9999, ch: "room:42", event: "messages.insert", payload: { id: 10 } }));
  await until("refused", () => socket.heard.some(h => h["ref"] === 9999));
  assert.deepEqual(socket.heard.find(h => h["ref"] === 9999), { op: "error", ref: 9999, code: "invalid_event" });
  assert.ok(sockets.every(s => !s.heard.some(h => h["op"] === "msg" && (h["payload"] as { id?: number } | null)?.id === 10)));
});

test("the tool's event named joined or resync is an event, not the channel's lifecycle", async () => {
  const c = await start();
  const b = open(c, dan);
  const { room, joins, resyncs } = listen(b, "room:42");
  const heard: [string, unknown][] = [];
  for (const event of ["joined", "resync", "kicked", "refused"]) room.on(event, payload => heard.push([event, payload]));
  let kicked = 0;
  const refused: string[] = [];
  room.onKicked(() => kicked++);
  room.onRefused(code => refused.push(code));
  await until("joined", () => joins.length === 1);
  for (const event of ["joined", "resync", "kicked", "refused"]) await realtime.publish("room:42", event, event);
  await until("heard", () => heard.length === 4);
  assert.deepEqual(heard, [["joined", "joined"], ["resync", "resync"], ["kicked", "kicked"], ["refused", "refused"]]);
  assert.deepEqual(joins, [{ replayed: false }]);
  assert.equal(resyncs(), 0);
  assert.deepEqual([kicked, refused], [0, []]);
});

test("a join the Chest has no room for is tried again quietly, then joins", async () => {
  const c = await start();
  const b = open(c, dan);
  const statuses: boolean[] = [];
  b.on("status", connected => statuses.push(connected));
  c.realtime.full(10, "joins");
  const { room, heard, joins } = listen(b, "room:42");
  const refused: string[] = [];
  room.onRefused(code => refused.push(code));
  const fulls = () => sockets[0]!.heard.filter(h => h["code"] === "full").length;
  await waitOut("tried again", () => fulls() >= 3);
  c.realtime.advance(10 * 1000);
  await waitOut("joined", () => joins.length === 1);
  assert.deepEqual(refused, []);
  assert.deepEqual(statuses, [true]);
  assert.equal(sockets.length, 1);
  c.realtime.commit("messages", "insert", { id: 1, room_id: 42 });
  await until("a row", () => heard.length === 1);
});

test("focus: the members watching a channel are those whose page is focused on it and shown", () => browser(async (_, document) => {
  const c = await start();
  const a = open(c, camille), b = open(c, dan);
  const roomA = listen(a, "room:42"), everyone = listen(b, "everyone");
  // watching waits until the Chest says those watching a channel are these.
  const watching = async (channel: string | undefined, expected: string[]) => {
    let got: { online: string[]; watching: string[] } | undefined;
    for (let i = 0; i < 300; i++) {
      got = await realtime.online([camille.id, dan.id], channel === undefined ? {} : { channel });
      if (JSON.stringify(got.watching) === JSON.stringify(expected)) break;
      await new Promise(resolve => realTimeout(resolve, 10));
    }
    assert.deepEqual(got, { online: [camille.id, dan.id], watching: expected });
  };
  // Focused before joining: told once joined.
  a.focus("room:42");
  b.focus("everyone");
  await until("joined", () => roomA.joins.length === 1 && everyone.joins.length === 1);
  await watching("room:42", [camille.id]);
  await watching("everyone", [dan.id]);
  await watching(undefined, []);
  // Hidden, none; shown again, the same.
  document.visibilityState = "hidden";
  document.dispatch("visibilitychange");
  await watching("room:42", []);
  document.visibilityState = "visible";
  document.dispatch("visibilitychange");
  await watching("room:42", [camille.id]);
  // Again after a reconnect.
  c.realtime.drop(camille.id);
  await until("the cut seen", () => sockets.some(s => s.closed && s.heard[0]?.["member"] === camille.id));
  back();
  await until("joined again", () => roomA.joins.length === 2);
  await watching("room:42", [camille.id]);
  // Unfocused, and left.
  a.focus(null);
  await watching("room:42", []);
  a.focus("room:42");
  await watching("room:42", [camille.id]);
  roomA.room.leave();
  await watching("room:42", []);
  // The Chest refuses a focus on a channel not joined.
  const socket = sockets.find(s => s.heard[0]?.["member"] === dan.id)!;
  socket.send(JSON.stringify({ op: "focus", ref: 9999, ch: "room:42" }));
  await until("refused", () => socket.heard.some(h => h["ref"] === 9999));
  assert.deepEqual(socket.heard.find(h => h["ref"] === 9999), { op: "error", ref: 9999, code: "forbidden" });
}));

test("a commit runs every feed of its table: its channel from the row's column, its columns only, nothing for a null column", async () => {
  const c = await start(["members", "realtime"], [
    { table: "messages", channel: "room:{room_id}", columns: ["id", "text"] },
    { table: "messages", channel: "inbox:{author}", columns: ["id"] },
  ]);
  const b = open(c, dan);
  const { room, joins } = listen(b, "room:42");
  const rows: [unknown, EventInfo][] = [];
  room.on("messages.insert", (row, info) => rows.push([row, info]));
  await until("joined", () => joins.length === 1);
  assert.deepEqual(c.realtime.commit("messages", "insert", { id: 1, room_id: 42, author: dan.id, text: "hi" }), [1, 2]);
  assert.deepEqual(c.realtime.commit("messages", "update", { id: 1, room_id: 42, author: null, text: "hello" }), [3]);
  assert.deepEqual(c.realtime.commit("messages", "delete", { id: 1 }), []);
  assert.deepEqual(c.realtime.commit("rooms", "insert", { id: 42 }), []);
  assert.deepEqual(c.realtime.published, [
    { channel: "room:42", event: "messages.insert", payload: { id: 1, text: "hi" }, seq: 1 },
    { channel: "inbox:" + dan.id, event: "messages.insert", payload: { id: 1 }, seq: 1 },
    { channel: "room:42", event: "messages.update", payload: { id: 1, text: "hello" }, seq: 2 },
  ]);
  await until("the row", () => rows.length === 1);
  assert.deepEqual(rows, [[{ id: 1, text: "hi" }, { pos: 1 }]]);
});

// The browser's module imports nothing: a page may load it as it is,
// served beside its own script, without a bundler.
test("the browser client is one module, importing nothing", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/realtime-client.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^\s*(import|export)\s[^;]*\sfrom\s/mu);
});
