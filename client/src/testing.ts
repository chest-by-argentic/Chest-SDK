import { createHash, createHmac, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ChestEvent } from "./events.js";
import { groupIdPattern, memberIdPattern, type Member } from "./member.js";
import { forget } from "./members.js";

// For a tool's own tests, never imported by its production code: a member's
// assertion signed as the Chest signs it, and a Chest's API in the test's
// process that answers members, groups, files (stat, move, links; an upload
// it authorises but does not receive), badges, notifications and the
// acknowledgment of an erasure with the Chest's bounds, quotas and errors;
// and that delivers an event to the tool, signed as the Chest signs it.
//
//   import { fakeChest, withMember } from "@argentic/chest-sdk/testing";
//   const chest = await fakeChest({ members: [camille], capabilities: ["members", "files", "notifications"] });
//   const response = await app(withMember(new Request("http://tool/chest"), camille));
//   assert.equal(chest.notifications[0]?.member, camille.id);
//   assert.equal(await chest.emit({ type: "access.revoked", data: { id: camille.id } }, request => app(request)), 204);
//   await chest.close();

// A group as a fake Chest keeps it: its identifier, its name, and the
// identifiers of the members it gives the tool to.
export type FakeGroup = { id: string; name: string; members: string[] };
// A file as a fake Chest keeps it.
export type FakeFile = { data: Uint8Array; type: string; updated: string };
// A notification as a fake Chest keeps it: the member it went to, its text
// cleaned as the Chest cleans it, its path (/chest when not said) and its
// key.
export type FakeNotification = { member: string; title: string; body?: string; path: string; key?: string };

// What a fake Chest is given: the members who have the tool, those who left
// it (erased: their data was erased, the name gone), its groups, the
// capabilities its version holds (a capability left out answers 403;
// members, files and notifications by default, members.email to read the
// addresses), the events it receives (["member.*"] by default, [] to answer
// an acknowledgment 403) and the files it keeps.
export type FakeChestOptions = {
  members?: Member[];
  former?: { id: string; name?: string; erased?: boolean }[];
  groups?: FakeGroup[];
  capabilities?: string[];
  receives?: string[];
  files?: Record<string, { data: Uint8Array | string; type?: string }>;
};

// An event for emit: its type and data; its id (a new evt_… by default) and
// when it happened (now by default) may be named, to deliver the same event
// twice.
export type FakeEvent = { [K in ChestEvent["type"]]: { type: K; data: Extract<ChestEvent, { type: K }>["data"]; id?: string; occurredAt?: string } }[ChestEvent["type"]];

// A fake Chest in the test's process: its address, the token and the tool it
// set in the environment, what it keeps (members, groups and files a test
// changes or reads; the notifications the tool sent, in the order sent, a
// replaced one last; each member's badge; the erasures the tool
// acknowledged), emit, which delivers an event to the tool — POST
// /chest-events of its address, or a handler of Web Requests — and says the
// status it answered, and close, which stops it and restores the
// environment. Its members are those who have the tool: the others are
// skipped.
export type FakeChest = {
  api: string;
  token: string;
  tool: string;
  members: Member[];
  groups: FakeGroup[];
  files: Map<string, FakeFile>;
  notifications: FakeNotification[];
  badges: Map<string, number>;
  acknowledged: string[];
  emit(event: FakeEvent, to: string | ((request: Request) => Response | Promise<Response>)): Promise<number>;
  close(): Promise<void>;
};

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

// signAssertion is the Chest-Member value the Chest's front would send for
// that member: HS256 under the key of the token (CHEST_TOKEN by default), for
// the tool (CHEST_TOOL by default), valid 60 seconds from now.
export function signAssertion(member: Member, options: { token?: string; tool?: string; now?: Date } = {}): string {
  const token = options.token ?? process.env["CHEST_TOKEN"];
  const tool = options.tool ?? process.env["CHEST_TOOL"];
  if (!token || !tool) throw new Error("signAssertion needs a token and a tool: start a fakeChest, or name them");
  if (!memberIdPattern.test(member.id) || !member.groups.every(g => groupIdPattern.test(g))) throw new Error("signAssertion needs identifiers of the Chest's shape (mbr_…, grp_…)");
  const iat = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const body = encode({ alg: "HS256", typ: "JWT" }) + "." + encode({
    iss: `https://${tool}-chest.chest.test`, aud: tool, iat, exp: iat + 60, sub: member.id,
    given_name: member.firstName, family_name: member.lastName, name: member.name, picture: member.photo ?? "", role: member.role ?? "",
    admin: member.isAdmin, builder: member.isBuilder, groups: member.groups, ...(member.email === undefined ? {} : { email: member.email }),
  });
  // The key as the Chest derives it, and member() reads it: HMAC-SHA256 of
  // the label of the assertion's shape under the text of the token.
  const key = createHmac("sha256", Buffer.from(token, "utf8")).update("Chest-Member v2").digest();
  return body + "." + createHmac("sha256", key).update(body).digest("base64url");
}

// signEvent is the Chest-Event value the Chest would send with that body:
// HS256 under the key the token derives for events, for the tool, naming the
// event and the digest of the body, valid 60 seconds.
function signEvent(id: string, body: string, options: { token: string; tool: string }): string {
  const iat = Math.floor(Date.now() / 1000);
  const signed = encode({ alg: "HS256", typ: "JWT" }) + "." + encode({ aud: options.tool, iat, exp: iat + 60, jti: id, digest: createHash("sha256").update(body).digest("base64url") });
  const key = createHmac("sha256", Buffer.from(options.token, "utf8")).update("Chest-Event v1").digest();
  return signed + "." + createHmac("sha256", key).update(signed).digest("base64url");
}

// withMember is the request carrying that member's assertion: a new Web
// Request, or the same Node request with its header set.
export function withMember<R extends Request | IncomingMessage>(request: R, member: Member, options: { token?: string; tool?: string; now?: Date } = {}): R {
  const assertion = signAssertion(member, options);
  if (request instanceof Request) {
    const headers = new Headers(request.headers);
    headers.set("Chest-Member", assertion);
    return new Request(request, { headers }) as R;
  }
  (request as IncomingMessage).headers["chest-member"] = assertion;
  return request;
}

// The bounds of a Chest (chest/toolmembers, chest/toolfiles).
const maxLimit = 500, defaultLimit = 100, maxLookup = 200, callsPerMinute = 600;
const maxObject = 32 << 20, maxObjects = 10000, maxTotal = 1 << 30;
const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){0,7}$/u;
// Its notifications: recipients and badges a call, text, quotas.
const maxRecipients = 500, maxTitle = 80, maxText = 280, maxPath = 512, maxCount = 9999;
const recipientsPerHour = 1000, itemsPerDay = 100, badgesPerMinute = 600;
const keyPattern = /^[a-z0-9._:-]{1,64}$/u;
const reordering = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const cleanTitle = (s: string): string => s.replace(/[\t\r\n]/gu, " ").replace(/\p{Cc}/gu, "").replace(reordering, "").trim();
const cleanText = (s: string): string => s.replace(/\r\n?/gu, "\n").replace(/\t/gu, " ").replace(/[^\P{Cc}\n]/gu, "").replace(reordering, "").trim();
const isPath = (p: unknown): boolean => typeof p === "string" && p.length <= maxPath && /^\/chest([/?#][\x21-\x5b\x5d-\x7e]*)?$/u.test(p) && !p.includes("//") && !p.split(/[?#]/u)[0]!.split("/").some(x => /^(\.|%2e){1,2}$/iu.test(x));

const fold = (s: string): string => s.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase();

function send(response: ServerResponse, status: number, value?: unknown, headers: Record<string, string> = {}): void {
  if (value === undefined) return void response.writeHead(status, headers).end();
  const raw = JSON.stringify(value);
  response.writeHead(status, { ...headers, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(raw)) }).end(raw);
}
async function body(request: IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

// fakeChest starts a Chest's API on 127.0.0.1 and points the environment at
// it: CHEST_API, CHEST_TOKEN (a new one) and CHEST_TOOL ("tool" unless the
// environment names one). What member() and the modules of the SDK read is
// then this Chest's.
export async function fakeChest(options: FakeChestOptions = {}): Promise<FakeChest> {
  const capabilities = new Set(options.capabilities ?? ["members", "files", "notifications"]);
  const email = capabilities.has("members.email");
  const tool = process.env["CHEST_TOOL"] || "tool";
  const token = randomBytes(32).toString("base64url");
  const files = new Map<string, FakeFile>();
  for (const [name, file] of Object.entries(options.files ?? {})) {
    files.set(name, { data: typeof file.data === "string" ? new TextEncoder().encode(file.data) : file.data, type: file.type ?? "application/octet-stream", updated: new Date().toISOString() });
  }
  const receives = options.receives ?? ["member.*"];
  // The erasures the tool was told of, by emit: those it may acknowledge.
  const erasures = new Set<string>();
  const chest: FakeChest = { api: "", token, tool, members: [...(options.members ?? [])], groups: [...(options.groups ?? [])], files, notifications: [], badges: new Map(), acknowledged: [], emit: async () => 0, close: async () => {} };
  const former = [...(options.former ?? [])];
  let window = 0, calls = 0;
  const shown = (m: Member) => ({ id: m.id, first_name: m.firstName, last_name: m.lastName, name: m.name, photo: m.photo, role: m.role, admin: m.isAdmin, builder: m.isBuilder, groups: m.groups, ...(email && m.email !== undefined ? { email: m.email } : {}) });
  const key = (m: Member) => fold(m.name) + "\u0000" + m.id;
  const described = (name: string, f: FakeFile) => ({ name, type: f.type, size: f.data.byteLength, updated: f.updated });

  async function members(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (!capabilities.has("members")) return send(response, 403, { error: "capability_not_granted" });
    const now = Date.now();
    if (now - window >= 60_000) [window, calls] = [now, 0];
    if (++calls > callsPerMinute) return send(response, 429, { error: "rate_limited" }, { "Retry-After": "60" });
    if (request.method === "GET" && url.pathname === "/members") {
      const q = url.searchParams, keys = [...q.keys()];
      const limit = q.has("limit") ? Number(q.get("limit")) : defaultLimit;
      const after = q.has("after") ? Buffer.from(q.get("after")!, "base64url").toString() : "";
      if (q.has("after") && !memberIdPattern.test(after.split("\u0000")[1] ?? "")) return send(response, 400, { error: "invalid_query" });
      const group = q.get("group"), role = q.get("role"), search = fold(q.get("q") ?? "");
      if (keys.some(k => !["after", "limit", "q", "role", "group"].includes(k) || q.getAll(k).length !== 1) || !Number.isInteger(limit) || limit < 1 || limit > maxLimit || String(limit) !== (q.get("limit") ?? String(defaultLimit)) || (group !== null && !groupIdPattern.test(group)) || search.length > 64) return send(response, 400, { error: "invalid_query" });
      const shownList = chest.members
        .filter(m => (role === null || m.role === role) && (group === null || m.groups.includes(group)) && (search === "" || [m.firstName, m.lastName, m.name, ...(email && m.email ? [m.email] : [])].some(n => fold(n).startsWith(search))))
        .filter(m => after === "" || key(m) > after)
        .sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
      const page = shownList.slice(0, limit);
      return send(response, 200, { members: page.map(shown), next: shownList.length > limit ? Buffer.from(key(page.at(-1)!)).toString("base64url") : null });
    }
    if (request.method === "POST" && url.pathname === "/members/lookup") {
      const raw = await body(request, 64 << 10);
      let ids: unknown;
      try { ids = (JSON.parse(raw?.toString() ?? "") as { ids?: unknown }).ids; } catch { ids = undefined; }
      if (!Array.isArray(ids) || ids.length > maxLookup) return send(response, 400, { error: "invalid_body" });
      if (!ids.every(id => typeof id === "string" && memberIdPattern.test(id))) return send(response, 400, { error: "invalid_id" });
      const answer = { members: [] as unknown[], former: [] as unknown[], unknown: [] as string[] };
      for (const id of new Set(ids as string[])) {
        const m = chest.members.find(x => x.id === id), f = former.find(x => x.id === id);
        if (m) answer.members.push(shown(m));
        else if (f?.erased) answer.former.push({ id, status: "erased" });
        else if (f) answer.former.push({ id, ...(f.name ? { name: f.name } : {}), status: "former" });
        else answer.unknown.push(id);
      }
      return send(response, 200, answer);
    }
    if (request.method === "GET" && url.pathname.startsWith("/members/")) {
      const id = url.pathname.slice("/members/".length);
      if (!memberIdPattern.test(id)) return send(response, 400, { error: "invalid_id" });
      const m = chest.members.find(x => x.id === id);
      return m ? send(response, 200, shown(m)) : send(response, 404, { error: "member_not_found" });
    }
    if (request.method === "GET" && url.pathname === "/groups") return send(response, 200, { groups: chest.groups });
    send(response, 404, { error: "not_found" });
  }

  async function filesRoute(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (!capabilities.has("files")) return send(response, 403, { error: "capability_not_granted" });
    if (request.method === "GET" && url.pathname === "/files") {
      const prefix = url.searchParams.get("prefix") ?? "", after = url.searchParams.get("after") ?? "";
      const names = [...files.keys()].filter(n => n.startsWith(prefix) && n > after).sort();
      return send(response, 200, { files: names.slice(0, 1000).map(n => described(n, files.get(n)!)), next: names.length > 1000 ? names[999] : null });
    }
    if (request.method === "POST" && url.pathname === "/files/url") {
      const raw = await body(request, 4096);
      let name: unknown;
      try { name = (JSON.parse(raw?.toString() ?? "") as { name?: unknown }).name; } catch { name = undefined; }
      if (typeof name !== "string") return send(response, 400, { error: "invalid_body" });
      if (!files.has(name)) return send(response, 404, { error: "not_found" });
      return send(response, 200, { url: `https://${tool}-chest.chest.test/_chest/files/${Buffer.from(name).toString("base64url")}.fake`, expires_in: 900 });
    }
    if (request.method === "POST" && (url.pathname === "/files/move" || url.pathname === "/files/upload-url")) {
      const raw = await body(request, 4096);
      let command: Record<string, unknown> = {};
      try { command = JSON.parse(raw?.toString() ?? "") as Record<string, unknown>; } catch { command = {}; }
      if (url.pathname === "/files/upload-url") {
        // The upload itself goes from a member's browser to the team host,
        // which a fake Chest does not play: it only authorises it.
        if (typeof command["name"] !== "string") return send(response, 400, { error: "invalid_body" });
        return send(response, 200, { url: `https://${tool}-chest.chest.test/_chest/files/upload/${Buffer.from(command["name"]).toString("base64url")}.fake`, method: "PUT", expires_in: typeof command["expires_in"] === "number" ? command["expires_in"] : 900 });
      }
      const from = command["from"], to = command["to"];
      if (typeof from !== "string" || typeof to !== "string" || !namePattern.test(from) || !namePattern.test(to)) return send(response, 400, { error: "invalid_name" });
      const moving = files.get(from);
      if (!moving) return send(response, 404, { error: "not_found" });
      files.delete(from);
      files.set(to, moving);
      return send(response, 200, described(to, moving));
    }
    const name = decodeURIComponent(url.pathname.slice("/files/".length));
    if (!namePattern.test(name)) return send(response, 400, { error: "invalid_name" });
    const object = files.get(name);
    if (request.method === "PUT") {
      const data = await body(request, maxObject);
      if (data === null) return send(response, 413, { error: "too_large" });
      const total = [...files.entries()].reduce((sum, [n, f]) => n === name ? sum : sum + f.data.byteLength, 0);
      if (total + data.length > maxTotal || (!object && files.size >= maxObjects)) return send(response, 429, { error: "quota_exceeded" });
      const kept = { data: new Uint8Array(data), type: request.headers["content-type"] ?? "application/octet-stream", updated: new Date().toISOString() };
      files.set(name, kept);
      return send(response, 201, described(name, kept));
    }
    if (!object) return send(response, 404, { error: "not_found" });
    if (request.method === "GET" && url.searchParams.has("stat")) return send(response, 200, described(name, object));
    if (request.method === "GET") return void response.writeHead(200, { "Content-Type": object.type, "Content-Length": String(object.data.byteLength) }).end(object.data);
    if (request.method === "DELETE") {
      files.delete(name);
      return send(response, 204);
    }
    send(response, 404, { error: "not_found" });
  }

  // The windows of the notification quotas, each from the first call it
  // counts: the tool's recipients this hour, each member's items this day,
  // the tool's badge writes this minute.
  type Window = { start: number; count: number };
  const hour: Window = { start: 0, count: 0 }, minute: Window = { start: 0, count: 0 }, days = new Map<string, Window>();
  const live = (w: Window | undefined, span: number, now: number): boolean => w !== undefined && w.count > 0 && now - w.start < span;
  const wait = (w: Window, span: number, now: number): Record<string, string> => ({ "Retry-After": String(Math.max(1, Math.ceil((w.start + span - now) / 1000))) });
  const count = (w: Window, span: number, now: number, n: number): void => {
    if (!live(w, span, now)) [w.start, w.count] = [now, 0];
    w.count += n;
  };
  const access = (id: string) => chest.members.some(m => m.id === id);
  // drop removes kept notifications in place: a test may hold the list.
  const drop = (gone: (n: FakeNotification) => boolean): void => {
    for (let i = chest.notifications.length - 1; i >= 0; i--) if (gone(chest.notifications[i]!)) chest.notifications.splice(i, 1);
  };
  // recipients reads 1 to 500 member identifiers, each once.
  function recipients(value: unknown): string[] | { error: string } {
    if (!Array.isArray(value) || value.length < 1 || value.length > maxRecipients) return { error: "invalid_body" };
    if (!value.every(v => typeof v === "string" && memberIdPattern.test(v))) return { error: "invalid_id" };
    return [...new Set(value as string[])];
  }

  async function notificationsRoute(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (!capabilities.has("notifications")) return send(response, 403, { error: "capability_not_granted" });
    const badge = request.method === "PUT" && url.pathname.startsWith("/badges/");
    if (!badge && !(request.method === "PUT" && url.pathname === "/badges") && !(request.method === "POST" && (url.pathname === "/notifications" || url.pathname === "/notifications/withdraw"))) return send(response, 404, { error: "not_found" });
    const raw = await body(request, 64 << 10);
    let command: Record<string, unknown> | null = null;
    try {
      const value = JSON.parse(raw?.toString() ?? "") as unknown;
      if (value !== null && typeof value === "object" && !Array.isArray(value)) command = value as Record<string, unknown>;
    } catch {
      command = null;
    }
    const keys = (...allowed: string[]) => command !== null && Object.keys(command).every(k => allowed.includes(k));
    const now = Date.now();
    if (badge || url.pathname === "/badges") {
      let writes: { member: string; count: number }[];
      if (badge) {
        const id = url.pathname.slice("/badges/".length);
        if (!memberIdPattern.test(id)) return send(response, 400, { error: "invalid_id" });
        if (!keys("count") || !("count" in command!)) return send(response, 400, { error: "invalid_body" });
        writes = [{ member: id, count: command!["count"] as number }];
      } else {
        const list = command?.["badges"];
        if (!keys("badges") || !Array.isArray(list) || list.length < 1 || list.length > maxRecipients || !list.every(b => b !== null && typeof b === "object" && !Array.isArray(b) && Object.keys(b).every(k => k === "member" || k === "count"))) return send(response, 400, { error: "invalid_body" });
        writes = list as { member: string; count: number }[];
        if (!writes.every(b => typeof b.member === "string" && memberIdPattern.test(b.member))) return send(response, 400, { error: "invalid_id" });
      }
      if (!writes.every(b => typeof b.count === "number" && Number.isInteger(b.count) && b.count >= 0 && b.count <= maxCount)) return send(response, 400, { error: "invalid_count" });
      if (new Set(writes.map(b => b.member)).size !== writes.length) return send(response, 400, { error: "invalid_body" });
      if (live(minute, 60_000, now) && minute.count + writes.length > badgesPerMinute) return send(response, 429, { error: "quota_exceeded" }, wait(minute, 60_000, now));
      count(minute, 60_000, now, writes.length);
      const answer = { set: [] as string[], skipped: [] as string[] };
      for (const b of writes) {
        if (!access(b.member)) {
          answer.skipped.push(b.member);
          continue;
        }
        if (b.count === 0) chest.badges.delete(b.member);
        else chest.badges.set(b.member, b.count);
        answer.set.push(b.member);
      }
      return send(response, 200, answer);
    }
    if (url.pathname === "/notifications/withdraw") {
      if (!keys("key", "members")) return send(response, 400, { error: "invalid_body" });
      const key = command!["key"];
      if (typeof key !== "string" || !keyPattern.test(key)) return send(response, 400, { error: "invalid_key" });
      const named = command!["members"] === undefined ? null : recipients(command!["members"]);
      if (named !== null && !Array.isArray(named)) return send(response, 400, named);
      drop(n => n.key === key && (named === null || named.includes(n.member)));
      return send(response, 204);
    }
    if (!keys("members", "title", "body", "path", "key")) return send(response, 400, { error: "invalid_body" });
    const { title, body: text, path, key } = command!;
    const ids = recipients(command!["members"]);
    if (!Array.isArray(ids)) return send(response, 400, ids);
    if (typeof title !== "string" || [...title].length < 1 || [...title].length > maxTitle || cleanTitle(title) === "") return send(response, 400, { error: "invalid_title" });
    if (text !== undefined && (typeof text !== "string" || [...text].length > maxText)) return send(response, 400, { error: "invalid_text" });
    if (path !== undefined && !isPath(path)) return send(response, 400, { error: "invalid_path" });
    if (key !== undefined && (typeof key !== "string" || !keyPattern.test(key))) return send(response, 400, { error: "invalid_key" });
    const kept = ids.filter(access);
    if (live(hour, 3_600_000, now) && hour.count + kept.length > recipientsPerHour) return send(response, 429, { error: "quota_exceeded" }, wait(hour, 3_600_000, now));
    const full = kept.map(id => days.get(id)).filter((w): w is Window => live(w, 86_400_000, now) && w!.count >= itemsPerDay);
    if (full.length > 0) return send(response, 429, { error: "quota_exceeded" }, wait(full.reduce((a, b) => a.start > b.start ? a : b), 86_400_000, now));
    count(hour, 3_600_000, now, kept.length);
    const cleaned = typeof text === "string" ? cleanText(text) : "";
    for (const id of kept) {
      if (!days.has(id)) days.set(id, { start: 0, count: 0 });
      count(days.get(id)!, 86_400_000, now, 1);
      if (key !== undefined) drop(n => n.member === id && n.key === key);
      chest.notifications.push({ member: id, title: cleanTitle(title), ...(cleaned ? { body: cleaned } : {}), path: (path as string | undefined) ?? "/chest", ...(key !== undefined ? { key: key as string } : {}) });
    }
    send(response, 200, { delivered: kept, skipped: ids.filter(id => !access(id)) });
  }

  // The acknowledgment of an erasure the tool was told of (emit).
  async function erasuresRoute(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (!receives.includes("member.*")) return send(response, 403, { error: "capability_not_granted" });
    const done = /^\/erasures\/([^/]+)\/done$/u.exec(url.pathname);
    if (request.method !== "POST" || !done || url.search) return send(response, 404, { error: "not_found" });
    const id = done[1]!;
    if (!/^era_[a-z2-7]{26}$/u.test(id)) return send(response, 400, { error: "invalid_id" });
    if (!erasures.has(id)) return send(response, 404, { error: "erasure_not_found" });
    if (!chest.acknowledged.includes(id)) chest.acknowledged.push(id);
    send(response, 204);
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const route = url.pathname.startsWith("/erasures/") ? erasuresRoute
      : url.pathname === "/members" || url.pathname.startsWith("/members/") || url.pathname === "/groups" ? members
      : url.pathname === "/files" || url.pathname.startsWith("/files/") ? filesRoute
      : url.pathname === "/badges" || url.pathname.startsWith("/badges/") || url.pathname.startsWith("/notifications") ? notificationsRoute : null;
    if (!route) return send(response, 404, { error: "not_found" });
    route(request, response, url).catch(() => { if (!response.headersSent) send(response, 503, { error: "unavailable" }); else response.destroy(); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const saved = Object.fromEntries(["CHEST_API", "CHEST_TOKEN", "CHEST_TOOL"].map(name => [name, process.env[name]]));
  chest.api = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  Object.assign(process.env, { CHEST_API: chest.api, CHEST_TOKEN: token, CHEST_TOOL: tool });
  forget();
  chest.emit = async (event, to) => {
    const id = event.id ?? "evt_" + Array.from(randomBytes(26), b => "abcdefghijklmnopqrstuvwxyz234567"[b & 31]).join("");
    const body = JSON.stringify({ id, type: event.type, occurredAt: event.occurredAt ?? new Date().toISOString(), data: event.data });
    if (event.type === "member.erased") erasures.add(event.data.erasure);
    const request = new Request(typeof to === "string" ? to.replace(/\/$/u, "") + "/chest-events" : "http://tool.test/chest-events", { method: "POST", headers: { "Content-Type": "application/json", "Chest-Event": signEvent(id, body, { token, tool }) }, body });
    const answer = typeof to === "string" ? await fetch(request, { redirect: "manual" }) : await to(request);
    await answer.body?.cancel();
    return answer.status;
  };
  chest.close = async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    forget();
  };
  return chest;
}
