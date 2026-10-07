import { createHash, randomBytes } from "node:crypto";
import { STATUS_CODES, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { memberIdPattern } from "./member.js";
import { channelPattern, eventPattern, type Present } from "./realtime.js";
import { peerEventPattern } from "./realtime-client.js";

// The realtime of a fake Chest (testing.ts): the tool's API (/realtime/*)
// with the Chest's bounds, and the Chest's side of the pages — a hub on the
// fake Chest's own origin, which @argentic/chest-sdk/realtime/client
// connects to with connect({ url: chest.realtime.url(member) }) — under the
// rules of the tool's chest.json. Rows of feeds are committed by the test
// (commit), membership rows removed by it (removed): there is no database,
// but the Chest's change log of the tool (each committed row's position,
// kept 7 days) and its memory of each channel (2 minutes), on a clock the
// test moves (advance). Not a published module.

// A channel as chest.json declares it (its "realtime" key).
export type FakeChannelRule = { name: string; join?: string[] | { table: string; key: string; member: string }; send?: boolean; presence?: boolean };
// A feed as chest.json declares it.
export type FakeFeed = { table: string; channel: string; columns: string[] };
// The realtime of a fake Chest: the tool's channels and feeds, as its
// chest.json declares them, and who is in a membership table (none by
// default).
export type FakeRealtimeOptions = { channels?: FakeChannelRule[]; feeds?: FakeFeed[]; membership?: (table: string, key: string, member: string) => boolean };
// What the tool published, and sent to members, in order.
export type FakePublished = { channel: string; event: string; payload: unknown; seq: number };
export type FakeSent = { members: string[]; event: string; payload: unknown };
export type FakeRealtime = {
  published: FakePublished[];
  sent: FakeSent[];
  // renewals counts the pages' questions to the Chest without upgrading:
  // each renews the member's session (every 5 minutes while connected, and
  // before connecting again).
  renewals: number;
  // url is where a page of that member connects (the fake Chest has no
  // session: the member is in the address).
  url(memberId: string): string;
  // commit is a row committed to a table, whole as the database holds it,
  // as the Chest's triggers tell it: for each feed of the table, in the
  // order declared, the next position of the tool's change log, published
  // to the feed's channel — its template filled from the row's column it
  // names, which need not be carried — with the feed's columns only. The
  // positions given; none for a feed whose column is null or absent.
  commit(table: string, op: "insert" | "update" | "delete", row: Record<string, unknown>): number[];
  // removed is a row of a membership table that went: its member leaves
  // the channels it gave them, at once.
  removed(table: string, key: string, member: string): void;
  // drop cuts the member's pages as a network would, or closes them with a
  // code and reason (1001 going away, 1013 try later, 1008 session_ended):
  // they reconnect.
  drop(memberId: string, code?: number, reason?: string): void;
  // revoke closes the member's pages as the Chest does when their access is
  // taken back: they stop.
  revoke(memberId: string): void;
  // signOut ends the member's session: the next renewal of their pages
  // answers 401 (they stop), and they connect no more.
  signOut(memberId: string): void;
  // full makes the Chest without room for that many seconds: connections
  // are refused, and the question before connecting answers 503 with
  // Retry-After — or, for "joins", its memory holds no more: a join answers
  // full (the page tries again later).
  full(seconds: number, what?: "connections" | "joins"): void;
  // advance moves the Chest's clock forward: its memory (2 minutes), its
  // change log (7 days) and a full Chest's wait age as much.
  advance(ms: number): void;
};

const protocol = "chest-realtime.v1", maxPayload = 64 << 10, maxSend = 4 << 10, maxState = 1 << 10;
// How long the Chest keeps a channel's frames in memory, and the tool's
// committed rows in its change log.
const memoryFor = 2 * 60 * 1000, logFor = 7 * 24 * 60 * 60 * 1000;

// A page: its channels, those it is present in, the one it has on screen
// ("" none).
type Page = { member: string; joined: Set<string>; tracked: Set<string>; focus: string; write(value: unknown): void; close(code: number, reason: string): void; cut(): void };
// A channel: its last number, the frames its memory keeps (forgotten: the
// last number it no longer keeps), who is present.
type ChannelState = { seq: number; kept: { seq: number; at: number; frame: unknown }[]; forgotten: number; present: Map<string, { state: unknown; tracked: number }> };
// A row of the tool's change log, as a replay gives it.
type Logged = { pos: number; at: number; channel: string; frame: { op: "msg"; ch: string; event: string; payload: unknown; pos: number } };

// prefixOf splits a pattern into its fixed part and its variable last
// segment ("" for an exact name).
function prefixOf(name: string): [string, string] {
  const at = name.lastIndexOf(":");
  const last = name.slice(at + 1);
  return last === "*" || /^\{[a-z_][a-z0-9_]*\}$/u.test(last) ? [name.slice(0, at + 1), last] : [name, ""];
}
function matches(rule: FakeChannelRule, name: string, member: string): boolean {
  const [prefix, variable] = prefixOf(rule.name);
  if (!variable) return name === prefix;
  const last = name.startsWith(prefix) ? name.slice(prefix.length) : "";
  return /^[a-z0-9_-]{1,64}$/u.test(last) && (variable !== "{member}" || last === member);
}

export function fakeRealtime(options: FakeRealtimeOptions, origin: () => string, roleOf: (member: string) => string | null | undefined) {
  const channels = new Map<string, ChannelState>();
  const pages = new Set<Page>();
  const epoch = randomBytes(9).toString("base64url");
  // The change log: its rows, the last position given, the last one no
  // longer kept. The clock: the test's advance on top of the real one.
  const log: Logged[] = [], signedOut = new Set<string>();
  let head = 0, logForgotten = 0, skew = 0, fullUntil = 0, joinsFullUntil = 0;
  const now = () => Date.now() + skew;
  const realtime: FakeRealtime = {
    published: [], sent: [], renewals: 0,
    url: member => origin().replace(/^http/u, "ws") + "/_chest/realtime?member=" + encodeURIComponent(member),
    commit(table, op, row) {
      const positions: number[] = [];
      for (const feed of options.feeds ?? []) {
        if (feed.table !== table) continue;
        const [prefix, variable] = prefixOf(feed.channel);
        const suffix = variable ? row[variable.slice(1, -1)] : "";
        if (suffix === null || suffix === undefined) continue;
        const channel = prefix + String(suffix), event = table + "." + op, payload = Object.fromEntries(feed.columns.map(c => [c, row[c] ?? null]));
        const pos = ++head;
        log.push({ pos, at: now(), channel, frame: { op: "msg", ch: channel, event, payload, pos } });
        publish(channel, event, payload, pos);
        positions.push(pos);
      }
      return positions;
    },
    removed(table, key, member) {
      for (const rule of options.channels ?? []) {
        if (typeof rule.join !== "object" || Array.isArray(rule.join) || rule.join.table !== table) continue;
        const name = prefixOf(rule.name)[0] + key;
        for (const page of pages) if (page.member === member && page.joined.has(name)) kick(page, name);
      }
    },
    drop(member, code, reason = "") { for (const page of [...pages]) if (page.member === member) code === undefined ? page.cut() : page.close(code, reason); },
    revoke(member) { for (const page of [...pages]) if (page.member === member) page.close(1008, "access_removed"); },
    signOut(member) { signedOut.add(member); },
    full(seconds, what = "connections") {
      if (what === "joins") joinsFullUntil = now() + seconds * 1000;
      else fullUntil = now() + seconds * 1000;
    },
    advance(ms) { skew += ms; },
  };
  const rule = (name: string, member: string) => name.length <= 128 && channelPattern.test(name) ? (options.channels ?? []).find(r => matches(r, name, member)) : undefined;
  const declared = (name: string) => rule(name, name.slice(name.lastIndexOf(":") + 1)) !== undefined;
  const allows = (r: FakeChannelRule, member: string) => !Array.isArray(r.join) || r.join.includes(roleOf(member) ?? "");
  // fed says whether a feed's rows go to the channel.
  const fed = (name: string) => (options.feeds ?? []).some(f => {
    const [prefix, variable] = prefixOf(f.channel);
    return variable ? name.startsWith(prefix) && !name.slice(prefix.length).includes(":") : name === prefix;
  });
  // state is a channel, its memory and the change log aged to now.
  const state = (name: string): ChannelState => {
    let ch = channels.get(name);
    if (!ch) channels.set(name, ch = { seq: 0, kept: [], forgotten: 0, present: new Map() });
    while (ch.kept[0] && ch.kept[0].at <= now() - memoryFor) ch.forgotten = ch.kept.shift()!.seq;
    while (log[0] && log[0].at <= now() - logFor) logForgotten = log.shift()!.pos;
    return ch;
  };
  function publish(channel: string, event: string, payload: unknown, pos?: number): number {
    const ch = state(channel);
    const frame = { op: "msg", ch: channel, event, payload, seq: ++ch.seq, ...(pos === undefined ? {} : { pos }) };
    ch.kept.push({ seq: ch.seq, at: now(), frame });
    realtime.published.push({ channel, event, payload, seq: ch.seq });
    for (const page of pages) if (page.joined.has(channel)) page.write(frame);
    return ch.seq;
  }
  function untrack(page: Page, name: string) {
    const ch = channels.get(name), p = ch?.present.get(page.member);
    if (!ch || !p || !page.tracked.delete(name) || --p.tracked > 0) return;
    ch.present.delete(page.member);
    for (const other of pages) if (other.joined.has(name) && other.member !== page.member) other.write({ op: "presence", ch: name, joins: [], leaves: [page.member] });
  }
  // part takes a page out of a channel, and forgets its focus there.
  function part(page: Page, name: string) {
    untrack(page, name);
    page.joined.delete(name);
    if (page.focus === name) page.focus = "";
  }
  function kick(page: Page, name: string) {
    part(page, name);
    page.write({ op: "kicked", ch: name });
  }

  // The tool's API: what the Chest's answers, with its errors.
  async function api(request: IncomingMessage, response: ServerResponse, url: URL, read: (request: IncomingMessage, limit: number) => Promise<Buffer | null>, send: (response: ServerResponse, status: number, value?: unknown) => void): Promise<void> {
    if (request.method === "GET" && url.pathname === "/realtime/presence") {
      const name = url.searchParams.get("channel") ?? "";
      if (!declared(name)) return send(response, 400, { error: "invalid_channel" });
      return send(response, 200, { members: [...(channels.get(name)?.present ?? [])].map(([id, p]) => ({ id, state: p.state })) });
    }
    if (request.method !== "POST" || !["/realtime/publish", "/realtime/send", "/realtime/online"].includes(url.pathname)) return send(response, 404, { error: "not_found" });
    const raw = await read(request, maxPayload + 1024 + 64 * 1000);
    let command: Record<string, unknown>;
    try { command = JSON.parse(raw?.toString() ?? "") as Record<string, unknown>; } catch { return send(response, 400, { error: "invalid_body" }); }
    if (command === null || typeof command !== "object") return send(response, 400, { error: "invalid_body" });
    const payload = command["payload"] ?? null;
    if (Buffer.byteLength(JSON.stringify(payload)) > maxPayload) return send(response, 413, { error: "too_large" });
    const members = command["members"];
    if (url.pathname !== "/realtime/publish" && (!Array.isArray(members) || members.length === 0 || !members.every(m => typeof m === "string" && memberIdPattern.test(m)))) return send(response, 400, { error: Array.isArray(members) && members.length > 0 ? "invalid_id" : "invalid_body" });
    const online = (ids: string[], focus?: string) => [...new Set(ids)].filter(id => [...pages].some(p => p.member === id && (focus === undefined || p.focus === focus)));
    if (url.pathname === "/realtime/online") {
      const channel = command["channel"];
      if (channel !== undefined && (typeof channel !== "string" || channel.length > 128 || !channelPattern.test(channel))) return send(response, 400, { error: "invalid_channel" });
      return send(response, 200, { online: online(members as string[]), watching: channel === undefined ? [] : online(members as string[], channel) });
    }
    const event = command["event"];
    if (typeof event !== "string" || !eventPattern.test(event)) return send(response, 400, { error: "invalid_event" });
    if (url.pathname === "/realtime/send") {
      realtime.sent.push({ members: [...members as string[]], event, payload });
      for (const page of pages) if ((members as string[]).includes(page.member)) page.write({ op: "direct", event, payload });
      return send(response, 200, { reached: online(members as string[]) });
    }
    const channel = command["channel"];
    if (typeof channel !== "string" || !declared(channel)) return send(response, 400, { error: "invalid_channel" });
    send(response, 200, { seq: publish(channel, event, payload) });
  }

  // refusal is why a member's page may not connect now: no access (403),
  // a session ended (401), no room (503, and in how many seconds).
  const refusal = (member: string): { status: 401 | 403 | 503; retryAfter?: number } | undefined => {
    if (roleOf(member) === undefined) return { status: 403 };
    if (signedOut.has(member)) return { status: 401 };
    if (fullUntil > now()) return { status: 503, retryAfter: Math.ceil((fullUntil - now()) / 1000) };
    return undefined;
  };
  // A page's question without upgrading, which renews its member's session:
  // may they connect now?
  function probe(response: ServerResponse, url: URL, send: (response: ServerResponse, status: number, value?: unknown, headers?: Record<string, string>) => void): void {
    realtime.renewals++;
    const refused = refusal(url.searchParams.get("member") ?? "");
    send(response, refused?.status ?? 204, undefined, refused?.retryAfter ? { "Retry-After": String(refused.retryAfter) } : {});
  }

  // A page's connection: the handshake, then the protocol's frames.
  function upgrade(request: IncomingMessage, socket: Duplex, url: URL): void {
    const member = url.searchParams.get("member") ?? "";
    const key = request.headers["sec-websocket-key"];
    const offered = String(request.headers["sec-websocket-protocol"] ?? "").split(",").map(s => s.trim());
    const status = typeof key !== "string" || !offered.includes(protocol) ? 403 : refusal(member)?.status;
    if (status !== undefined) {
      socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${protocol}\r\n\r\n`);
    const frame = (op: number, data: Buffer): Buffer => {
      const head = data.length < 126 ? Buffer.from([0x80 | op, data.length]) : data.length <= 0xffff ? Buffer.from([0x80 | op, 126, data.length >> 8, data.length & 0xff]) : Buffer.concat([Buffer.from([0x80 | op, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(data.length)); return b; })()]);
      return Buffer.concat([head, data]);
    };
    const page: Page = {
      member, joined: new Set(), tracked: new Set(), focus: "",
      write: value => { if (!socket.destroyed) socket.write(frame(0x1, Buffer.from(JSON.stringify(value)))); },
      close: (code, reason) => {
        const data = Buffer.alloc(2 + Buffer.byteLength(reason));
        data.writeUInt16BE(code);
        data.write(reason, 2);
        if (!socket.destroyed) socket.end(frame(0x8, data));
      },
      cut: () => socket.destroy(),
    };
    pages.add(page);
    const forget = () => {
      if (!pages.delete(page)) return;
      for (const name of [...page.tracked]) untrack(page, name);
    };
    socket.on("close", forget);
    socket.on("error", forget);
    page.write({ op: "hello", epoch, member });
    let pending = Buffer.alloc(0), message: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        if (pending.length < 2) return;
        const fin = (pending[0]! & 0x80) !== 0, op = pending[0]! & 0x0f;
        let length = pending[1]! & 0x7f, at = 2;
        if (length === 126) { if (pending.length < 4) return; length = pending.readUInt16BE(2); at = 4; }
        else if (length === 127) { if (pending.length < 10) return; length = Number(pending.readBigUInt64BE(2)); at = 10; }
        if (pending.length < at + 4 + length) return;
        const mask = pending.subarray(at, at + 4), data = Buffer.from(pending.subarray(at + 4, at + 4 + length));
        for (let i = 0; i < data.length; i++) data[i]! ^= mask[i & 3]!;
        pending = pending.subarray(at + 4 + length);
        if (op === 0x8) return page.close(1000, "");
        if (op === 0x9) { socket.write(frame(0xa, data)); continue; }
        if (op !== 0x1 && op !== 0x0) continue;
        message.push(data);
        if (!fin) continue;
        const text = Buffer.concat(message).toString();
        message = [];
        let q: Record<string, unknown>;
        try { q = JSON.parse(text) as Record<string, unknown>; } catch { page.write({ op: "error", ref: 0, code: "invalid_request" }); continue; }
        handle(page, q);
      }
    });
  }

  function handle(page: Page, q: Record<string, unknown>): void {
    const ref = typeof q["ref"] === "number" ? q["ref"] : 0, name = typeof q["ch"] === "string" ? q["ch"] : "";
    const answer = (code?: string, extra: Record<string, unknown> = {}) => { if (ref !== 0 || code === "invalid_request") page.write(code ? { op: "error", ref, code } : { op: "ok", ref, ...extra }); };
    const r = rule(name, page.member);
    switch (q["op"]) {
      case "ping":
        return answer();
      case "join": {
        if (!r) return answer("invalid_channel");
        if (!allows(r, page.member)) return answer("forbidden");
        const table = typeof r.join === "object" && !Array.isArray(r.join) ? r.join : undefined;
        if (table && !(options.membership?.(table.table, name.slice(prefixOf(r.name)[0].length), page.member) ?? false)) return answer("forbidden");
        if (joinsFullUntil > now()) return answer("full");
        page.joined.add(name);
        // A re-join is given what it missed: from the memory when it keeps
        // all of it (the tool's events too), else from the change log (the
        // feeds' rows), else told resync. A channel fed by a feed says the
        // position the page is at: the one it gave, or the head.
        const ch = state(name), since = q["since"] as { epoch?: unknown; seq?: unknown; pos?: unknown } | undefined;
        let missed: unknown[] = [], resync = false, pos = fed(name) ? head : undefined;
        if (since !== undefined) {
          const seq = Number(since.seq), given = Number(since.pos ?? 0);
          if (since.epoch === epoch && seq >= ch.forgotten && seq <= ch.seq) missed = ch.kept.filter(k => k.seq > seq).map(k => k.frame);
          else if (pos !== undefined && given > 0 && given >= logForgotten && given <= head) missed = log.filter(l => l.channel === name && l.pos > given).map(l => l.frame);
          else resync = true;
          if (!resync && pos !== undefined) pos = given;
        }
        answer(undefined, { seq: ch.seq, ...(pos === undefined ? {} : { pos }), ...(r.presence ? { presence: [...ch.present].map(([id, p]) => ({ id, state: p.state })) } : {}), ...(resync ? { resync } : {}) });
        for (const frame of missed) page.write(frame);
        return;
      }
      case "leave":
        part(page, name);
        return answer();
      case "focus":
        if (name !== "" && !page.joined.has(name)) return answer("forbidden");
        page.focus = name;
        return answer();
      // A member's message is a peer frame, its name never dotted: never
      // taken for the feeds' rows or the tool's events.
      case "send": {
        const payload = q["payload"] ?? null;
        if (typeof q["event"] !== "string" || !peerEventPattern.test(q["event"])) return answer("invalid_event");
        if (Buffer.byteLength(JSON.stringify(payload)) > maxSend) return answer("invalid_body");
        if (!r || !page.joined.has(name) || !r.send || !allows(r, page.member)) return answer("forbidden");
        for (const other of pages) if (other.member !== page.member && other.joined.has(name)) other.write({ op: "peer", ch: name, event: q["event"], payload, from: page.member });
        return answer();
      }
      case "track": {
        const value = q["state"];
        if (value === null || typeof value !== "object" || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > maxState) return answer("invalid_body");
        if (!r || !page.joined.has(name) || !r.presence) return answer("forbidden");
        const ch = state(name);
        let p = ch.present.get(page.member);
        if (!p) ch.present.set(page.member, p = { state: value, tracked: 0 });
        if (!page.tracked.has(name)) { page.tracked.add(name); p.tracked++; }
        p.state = value;
        for (const other of pages) if (other.member !== page.member && other.joined.has(name)) other.write({ op: "presence", ch: name, joins: [{ id: page.member, state: value as Present["state"] }], leaves: [] });
        return answer();
      }
      default:
        return answer("invalid_request");
    }
  }

  // close closes every page, as the Chest stopping would.
  const close = () => { for (const page of pages) page.close(1001, ""); };
  return { realtime, api, probe, upgrade, close };
}
