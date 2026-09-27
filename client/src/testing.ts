import { createHmac, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { groupIdPattern, memberIdPattern, type Member } from "./member.js";
import { forget } from "./members.js";

// For a tool's own tests, never imported by its production code: a member's
// assertion signed as the Chest signs it, and a Chest's API in the test's
// process that answers members, groups and files with the Chest's bounds and
// errors.
//
//   import { fakeChest, withMember } from "@argentic/chest-sdk/testing";
//   const chest = await fakeChest({ members: [camille], capabilities: ["members", "files"] });
//   const response = await app(withMember(new Request("http://tool/chest"), camille));
//   await chest.close();

// A group as a fake Chest keeps it: its identifier, its name, and the
// identifiers of the members it gives the tool to.
export type FakeGroup = { id: string; name: string; members: string[] };
// A file as a fake Chest keeps it.
export type FakeFile = { data: Uint8Array; type: string; updated: string };

// What a fake Chest is given: the members who have the tool, those who left
// it, its groups, the capabilities its version holds (a capability left out
// answers 403; members and files by default, members.email to read the
// addresses) and the files it keeps.
export type FakeChestOptions = {
  members?: Member[];
  former?: { id: string; name?: string }[];
  groups?: FakeGroup[];
  capabilities?: string[];
  files?: Record<string, { data: Uint8Array | string; type?: string }>;
};

// A fake Chest in the test's process: its address, the token and the tool it
// set in the environment, what it keeps (members, groups and files a test
// changes or reads), and close, which stops it and restores the environment.
export type FakeChest = {
  api: string;
  token: string;
  tool: string;
  members: Member[];
  groups: FakeGroup[];
  files: Map<string, FakeFile>;
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
  const capabilities = new Set(options.capabilities ?? ["members", "files"]);
  const email = capabilities.has("members.email");
  const tool = process.env["CHEST_TOOL"] || "tool";
  const token = randomBytes(32).toString("base64url");
  const files = new Map<string, FakeFile>();
  for (const [name, file] of Object.entries(options.files ?? {})) {
    files.set(name, { data: typeof file.data === "string" ? new TextEncoder().encode(file.data) : file.data, type: file.type ?? "application/octet-stream", updated: new Date().toISOString() });
  }
  const chest: FakeChest = { api: "", token, tool, members: [...(options.members ?? [])], groups: [...(options.groups ?? [])], files, close: async () => {} };
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
    if (request.method === "GET") return void response.writeHead(200, { "Content-Type": object.type, "Content-Length": String(object.data.byteLength) }).end(object.data);
    if (request.method === "DELETE") {
      files.delete(name);
      return send(response, 204);
    }
    send(response, 404, { error: "not_found" });
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const route = url.pathname === "/members" || url.pathname.startsWith("/members/") || url.pathname === "/groups" ? members : url.pathname === "/files" || url.pathname.startsWith("/files/") ? filesRoute : null;
    if (!route) return send(response, 404, { error: "not_found" });
    route(request, response, url).catch(() => { if (!response.headersSent) send(response, 503, { error: "unavailable" }); else response.destroy(); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const saved = Object.fromEntries(["CHEST_API", "CHEST_TOKEN", "CHEST_TOOL"].map(name => [name, process.env[name]]));
  chest.api = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  Object.assign(process.env, { CHEST_API: chest.api, CHEST_TOKEN: token, CHEST_TOOL: tool });
  forget();
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
