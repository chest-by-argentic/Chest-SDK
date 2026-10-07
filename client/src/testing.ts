import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import type { Alias, Provider } from "./ai.js";
import type { AiUnavailableReason } from "./errors.js";
import { clockSkew, eventWindow, fieldNamePattern, fieldOf, instantOf, isAudience, isDeclaredData, isToolEventType, itemIdPattern, maxData, rolePattern } from "./eventrules.js";
import type { ChestEvent, EmitAudience, ToolEvent } from "./events.js";
import { groupIdPattern, languagePattern, memberIdPattern, type Member } from "./member.js";
import { forget } from "./members.js";
import { eventChannel, json, object, scheduleChannel, sign, signClaims, type Channel } from "./signed.js";
import { fakeRealtime, type FakeRealtime, type FakeRealtimeOptions } from "./testing-realtime.js";

export type { FakeChannelRule, FakeFeed, FakePublished, FakeRealtime, FakeRealtimeOptions, FakeSent } from "./testing-realtime.js";

// For a tool's own tests, never imported by its production code: a member's
// assertion signed as the Chest signs it, and a Chest's API in the test's
// process that answers members, groups, files (stat, move, links and
// uploads — its members' and its visitors' —, which it serves and takes
// itself as the team host and the public part would, on its own origin),
// sealed values (sealed and opened under a key of its own,
// for the members and roles it keeps; withMember carries the member's
// ticket), badges, notifications and broadcasts, AI (chat,
// streamed or not, embeddings, models, usage: deterministic answers, no
// provider), the acknowledgment of an erasure, the events the tool emits
// (checked against the "emits" of its chest.json, as the Chest checks them,
// and kept in order) and realtime (the tool's publishes and sends, and the
// Chest's side of its pages, which the browser client connects to) with the
// Chest's bounds, quotas and errors; and that delivers an event — of the
// members' lifecycle, or of another tool — or a run of a schedule to the
// tool, signed as the Chest signs them.
//
//   import { fakeChest, withMember } from "@argentic/chest-sdk/testing";
//   const chest = await fakeChest({ members: [camille], capabilities: ["members", "files", "notifications"], emits: { "task.done": { description: "A task is done", data: { task: "id" } } } });
//   const response = await app(withMember(new Request("http://tool/chest"), camille));
//   assert.equal(chest.notifications[0]?.member, camille.id);
//   assert.equal(await chest.deliver({ type: "access.revoked", data: { id: camille.id } }, request => app(request)), 204);
//   assert.equal(await chest.deliver({ type: "quote.accepted", source: "quotes", data: { quote: "q-1" } }, request => app(request)), 204);
//   assert.equal(chest.emitted[0]?.type, "task.done");
//   assert.equal(await chest.run("morning", request => app(request)), 204);
//   await chest.close();

// A group as a fake Chest keeps it: its identifier, its name, the
// identifiers of its members, and whether it gives the tool (true by
// default). One that does not is seen — in groups and in each member's
// groups — only with the capability members.groups; a group's members are
// told among those who have the tool.
export type FakeGroup = { id: string; name: string; members: string[]; grants?: boolean };
// A file as a fake Chest keeps it.
export type FakeFile = { data: Uint8Array; type: string; updated: string };
// Someone the tool had who no longer has it: a member of the Chest without
// access to it, a member who left ("former", by default), or one whose data
// was erased (their name gone).
export type FakeFormer = { id: string; name?: string; status?: "no_access" | "former" | "erased" };
// A notification as a fake Chest keeps it: the member it went to, its text
// in that member's language — the translation of theirs, the tool's own
// otherwise — cleaned as the Chest cleans it, its path (/chest when not
// said) and its key. A broadcast keeps one for each member it reached.
// Beyond the pace, a member's notices are folded into one item, grouped
// counting them, its text and path the latest's.
export type FakeNotification = { member: string; title: string; body?: string; path: string; key?: string; grouped?: number };
// An alias a fake Chest maps: the model behind it, its provider (openrouter
// by default) and its prices in US dollars per million tokens (1 and 2 by
// default).
export type FakeAiModel = { alias: Alias; model: string; provider?: Provider; input?: number; output?: number };
// What a fake model answers: text, or text and tool calls (an id of call_…
// by default; arguments are JSON text).
export type FakeAiReply = string | { text?: string; toolCalls?: { name: string; arguments: string; id?: string }[] };
// The AI of a fake Chest: the aliases the tool declared, each mapped (all
// four by default: fake-default, fake-fast, fake-smart, fake-embedding); what
// its models answer to a chat, given the request as the tool sent it (the
// last user message's text, echoed, by default); the tool's monthly cap in
// euros (5 by default; a call is refused cap_reached once the spending
// reaches it, 0 refuses at once); and a reason that makes chat and
// embeddings unavailable.
export type FakeAi = { models?: FakeAiModel[]; reply?: (request: Record<string, unknown>) => FakeAiReply; cap?: number; unavailable?: AiUnavailableReason };
// A call of the tool to the AI of a fake Chest: its path and its body as
// sent (null for a GET).
export type FakeAiCall = { path: string; body: unknown };

// An open of sealed values the tool asked of a fake Chest, as the Chest
// journals it: the member on whose behalf, how many opened, how many
// refused — never a value.
export type FakeOpen = { member: string; opened: number; refused: number };

// What a fake Chest is given: the members who have the tool, those it had
// who no longer have it (FakeFormer), its groups, the
// capabilities its version holds (a capability left out answers 403;
// members, files, notifications and ai by default, members.email to read the
// addresses, members.groups to see every group, sealed to seal and open
// values), the roles the tool declares (any role of the grammar a value is
// sealed for, when not said), the events it receives (["member.*"] by default, [] to answer
// an acknowledgment 403), the events the tool emits (chest.json "emits":
// none by default, which answers an emit 403), the files it keeps, its AI, and what the Chest is
// (the chest module: "Test organization", UTC, English and euros by default;
// the tool at https://<tool>-chest.chest.test, its public part at
// https://<tool>.chest.test), and its realtime: the channels and feeds of
// its chest.json, and who is in its membership tables.
export type FakeChestOptions = {
  members?: Member[];
  former?: FakeFormer[];
  groups?: FakeGroup[];
  capabilities?: string[];
  roles?: string[];
  receives?: string[];
  emits?: Record<string, FakeEmits>;
  files?: Record<string, { data: Uint8Array | string; type?: string }>;
  ai?: FakeAi;
  realtime?: FakeRealtimeOptions;
  chest?: { organization?: string; timeZone?: string; language?: string; currency?: string; teamUrl?: string; publicUrl?: string | null };
};

// A type a tool emits, as its chest.json declares it in "emits": what
// happened, in a sentence of 1 to 80 characters, and each field of its data
// with its kind (id, text, number, boolean, time, date, member, members; a
// trailing ? for an optional one).
export type FakeEmits = { description: string; data: Record<string, string> };

// An event for deliver: of the members' lifecycle, its type and data; or of
// another tool, told apart by its source (the publisher's name), its type,
// data, subject (none by default) and audience ("all" by default, or the
// members of this tool who may see it). Its id (a new evt_… by default) and
// when it happened (now by default) may be named, to deliver the same event
// twice. It is signed as given: an envelope the Chest would never send
// makes handle() refuse it.
export type FakeEvent =
  | { [K in ChestEvent["type"]]: { type: K; data: Extract<ChestEvent, { type: K }>["data"]; id?: string; occurredAt?: string } }[ChestEvent["type"]]
  | { type: string; source: string; data: Record<string, unknown>; audience?: ToolEvent["audience"]; subject?: string; id?: string; occurredAt?: string };

// An event the tool emitted, as the fake Chest took it: its id, type and
// data, its subject and key when given, when it happened (the tool's time,
// or the Chest's), its audience when given, and the event whose handler
// emitted it (cause).
export type FakeEmitted = { id: string; type: string; data: Record<string, unknown>; subject?: string; key?: string; occurredAt: string; audience?: EmitAudience; cause?: string };

// A run for run: its id (a new run_… by default: name it to deliver the same
// run twice), the time it stands for (now by default) and its attempt (1 by
// default).
export type FakeRun = { id?: string; scheduledAt?: string; attempt?: number };

// A fake Chest in the test's process: its address — its API, and the origin
// where it serves the links and takes the uploads it signs —, the token and
// the tool it set in the environment, what it keeps (members, groups and files a test
// changes or reads; the notifications the tool sent, in the order sent, a
// replaced one last; each member's badge; the erasures the tool
// acknowledged; its calls to AI, in order; its opens of sealed values, in
// order; the events it emitted, in order; its realtime: what the tool
// published and sent, where a member's page connects, a feed's row
// committed, a membership row removed), deliver, which delivers an event to the tool — POST
// /chest-events of its address, or a handler of Web Requests — and says the
// status it answered, run, which delivers a run of a schedule the same way
// on /chest-schedules, and close, which stops it and restores the
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
  ai: FakeAiCall[];
  opens: FakeOpen[];
  realtime: FakeRealtime;
  emitted: FakeEmitted[];
  deliver(event: FakeEvent, to: string | ((request: Request) => Response | Promise<Response>)): Promise<number>;
  run(name: string, to: string | ((request: Request) => Response | Promise<Response>), run?: FakeRun): Promise<number>;
  close(): Promise<void>;
};

// What an assertion is signed with and says besides the member: the token
// (CHEST_TOKEN by default) and the tool (CHEST_TOOL by default) it is for,
// and when it is issued (now by default). The member is signed as given: a
// language or a zone the Chest would never send makes member() refuse the
// assertion, as it refuses the Chest's.
export type AssertionOptions = { token?: string; tool?: string; now?: Date };

// signAssertion is the Chest-Member value the Chest's front would send for
// that member: HS256 under the key of the token, for the tool, valid 60
// seconds from when it is issued.
export function signAssertion(member: Member, options: AssertionOptions = {}): string {
  const token = options.token ?? process.env["CHEST_TOKEN"];
  const tool = options.tool ?? process.env["CHEST_TOOL"];
  if (!token || !tool) throw new Error("signAssertion needs a token and a tool: start a fakeChest, or name them");
  if (!memberIdPattern.test(member.id) || !(member.groups ?? []).every(g => groupIdPattern.test(g))) throw new Error("signAssertion needs identifiers of the Chest's shape (mbr_…, grp_…)");
  const iat = Math.floor((options.now ?? new Date()).getTime() / 1000);
  // Under the label of the assertion's shape, as the Chest signs it and
  // member() reads it.
  return signClaims("Chest-Member v2", {
    iss: `https://${tool}-chest.chest.test`, aud: tool, iat, exp: iat + 60, sub: member.id,
    given_name: member.firstName, family_name: member.lastName, name: member.name, picture: member.photo ?? "", role: member.role ?? "",
    admin: member.isAdmin, builder: member.isBuilder, ...(member.groups === null ? { groups_overage: true } : { groups: member.groups }), time_zone: member.timeZone, ...(member.email === undefined ? {} : { email: member.email }),
    language: member.language,
  }, token);
}


// ticketOf makes the ticket of a member's request to open sealed values
// (Chest-Opener), under the key of the fake Chest running; null when none
// runs. The tool never holds that key: only the Chest makes tickets.
let ticketOf: ((id: string) => string) | null = null;

// withMember is the request carrying that member's assertion, signed with
// the options of signAssertion, and — while a fake Chest runs — the
// member's ticket to open sealed values: a new Web Request, or the same
// Node request with its headers set.
export function withMember<R extends Request | IncomingMessage>(request: R, member: Member, options: AssertionOptions = {}): R {
  const assertion = signAssertion(member, options);
  const ticket = ticketOf?.(member.id);
  if (request instanceof Request) {
    const headers = new Headers(request.headers);
    headers.set("Chest-Member", assertion);
    if (ticket) headers.set("Chest-Opener", ticket);
    return new Request(request, { headers }) as R;
  }
  (request as IncomingMessage).headers["chest-member"] = assertion;
  if (ticket) (request as IncomingMessage).headers["chest-opener"] = ticket;
  return request;
}

// The bounds of a Chest (chest/toolmembers, chest/toolfiles).
const maxLimit = 500, defaultLimit = 100, maxLookup = 200, callsPerMinute = 600;
const maxObject = 32 << 20, maxObjects = 10000, maxTotal = 1 << 30;
const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){0,7}$/u;
// Its links and uploads: their paths on the team host, their lives in
// seconds, the images it makes thumbnails of, the types it recognises by
// their content — a member's upload of one must hold it, a visitor's is of
// the one its content is —, the endings of the names it chooses
// (chest/toolfiles). An office document is told by the names of its parts,
// read in its bytes rather than in its archive's directory.
const linkPath = "/_chest/files/", uploadPath = "/_chest/files/upload/", linkLife = 900, uploadLife = 900;
const mediaPattern = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/(\*|[a-z0-9][a-z0-9!#$&^_.+-]{0,62})$/u;
const thumbnailed = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const starts = (...heads: string[]) => (data: Buffer): boolean => heads.some(head => data.subarray(0, head.length).equals(Buffer.from(head, "latin1")));
const text = (data: Buffer, from: number, to: number): string => data.subarray(from, to).toString("latin1");
const brands = (...said: string[]) => (data: Buffer): boolean => text(data, 4, 8) === "ftyp" && Array.from({ length: Math.max(0, Math.min(data.readUInt32BE(0), data.length) - 8) / 4 }, (_, i) => text(data, 8 + 4 * i, 12 + 4 * i)).some((brand, i) => i !== 1 && said.includes(brand));
const zip = starts("PK\x03\x04", "PK\x05\x06");
const office = (main: string) => (data: Buffer): boolean => zip(data) && data.includes("[Content_Types].xml") && data.includes(main);
const openDocument = (type: string) => (data: Buffer): boolean => zip(data) && text(data, 30, 38) === "mimetype" && text(data, 38, 38 + type.length) === type;
const recognisers: Record<string, (data: Buffer) => boolean> = {
  "image/jpeg": starts("\xff\xd8\xff"), "image/png": starts("\x89PNG\r\n\x1a\n"), "image/gif": starts("GIF87a", "GIF89a"),
  "image/webp": data => text(data, 0, 4) === "RIFF" && text(data, 8, 12) === "WEBP", "image/avif": brands("avif", "avis"), "image/heic": brands("heic", "heix", "heim", "heis", "hevc", "hevx"),
  "image/bmp": starts("BM"), "image/tiff": starts("II*\x00", "MM\x00*"), "application/pdf": starts("%PDF-"),
  "application/zip": zip, "application/gzip": starts("\x1f\x8b"), "application/x-7z-compressed": starts("7z\xbc\xaf\x27\x1c"), "application/vnd.rar": starts("Rar!\x1a\x07"),
  "application/x-tar": data => text(data, 257, 262) === "ustar", "application/x-bzip2": starts("BZh"), "application/x-xz": starts("\xfd7zXZ\x00"), "application/vnd.ms-cab-compressed": starts("MSCF"),
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": office("word/document.xml"),
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": office("xl/workbook.xml"),
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": office("ppt/presentation.xml"),
  "application/vnd.oasis.opendocument.text": openDocument("application/vnd.oasis.opendocument.text"),
  "application/vnd.oasis.opendocument.spreadsheet": openDocument("application/vnd.oasis.opendocument.spreadsheet"),
  "application/vnd.oasis.opendocument.presentation": openDocument("application/vnd.oasis.opendocument.presentation"),
};
// The types recognised, an office document before the archive it also is.
const precise = (type: string): boolean => type.includes("officedocument") || type.includes("opendocument");
const recognised = Object.keys(recognisers).sort((a, b) => Number(precise(b)) - Number(precise(a)) || (a < b ? -1 : a > b ? 1 : 0));
const accepted = (types: string[], type: string): boolean => types.some(t => t === type || (t.endsWith("/*") && type.startsWith(t.slice(0, -1))));
const extensions: Record<string, string> = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp", "image/avif": ".avif", "image/heic": ".heic", "image/bmp": ".bmp", "image/tiff": ".tiff",
  "application/pdf": ".pdf", "text/plain": ".txt", "text/csv": ".csv", "application/json": ".json", "application/zip": ".zip",
  "application/gzip": ".gz", "application/x-7z-compressed": ".7z", "application/vnd.rar": ".rar", "application/x-tar": ".tar", "application/x-bzip2": ".bz2", "application/x-xz": ".xz", "application/vnd.ms-cab-compressed": ".cab",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx", "application/vnd.oasis.opendocument.text": ".odt",
  "application/vnd.oasis.opendocument.spreadsheet": ".ods", "application/vnd.oasis.opendocument.presentation": ".odp", "video/mp4": ".mp4", "audio/mpeg": ".mp3",
};
const newToken = (): string => randomBytes(18).toString("base64url") + "." + randomBytes(12).toString("base64url");
// Its notifications: recipients and badges a call, text, quotas.
// No count bounds a call but the team's size: a body takes the texts and an
// entry for each member who has the tool. Nothing is refused for its pace:
// ten items at once to a member, one more every six minutes; beyond, the
// notices are folded into the one grouped item of that member.
const maxTitle = 80, maxText = 280, maxPath = 512, maxCount = 9999, maxRoles = 16;
const textBytes = 64 << 10, memberBytes = 64;
const paceBurst = 10, paceEvery = 6 * 60_000;
const keyPattern = /^[a-z0-9._:-]{1,64}$/u;
const reordering = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const cleanTitle = (s: string): string => s.replace(/[\t\r\n]/gu, " ").replace(/\p{Cc}/gu, "").replace(reordering, "").trim();
const cleanText = (s: string): string => s.replace(/\r\n?/gu, "\n").replace(/\t/gu, " ").replace(/[^\P{Cc}\n]/gu, "").replace(reordering, "").trim();
const isPath = (p: unknown): boolean => typeof p === "string" && p.length <= maxPath && /^\/chest([/?#][\x21-\x5b\x5d-\x7e]*)?$/u.test(p) && !p.includes("//") && !p.split(/[?#]/u)[0]!.split("/").some(x => /^(\.|%2e){1,2}$/iu.test(x));

// Its AI: aliases in order, bounds of a request, requests a minute.
const aliasOrder: readonly Alias[] = ["default", "fast", "smart", "embedding"];
const chatKeys = ["model", "messages", "max_tokens", "stream", "temperature", "top_p", "stop", "tools", "tool_choice", "response_format", "parallel_tool_calls", "seed", "reasoning_effort", "member"];
const maxAiBody = 10 << 20, maxAiOutput = 128000, maxInputs = 256, aiPerMinute = 60, fakeDimensions = 8;
// A fake count of tokens: one per 4 characters.
const tokensOf = (text: string): number => Math.ceil(text.length / 4);
// A vector of a text, the same for the same text: unit length.
function vectorOf(text: string, dimensions: number): number[] {
  const values: number[] = [];
  for (let block = 0; values.length < dimensions; block++) {
    for (const b of createHash("sha256").update(block + ":" + text).digest()) values.push(b / 127.5 - 1);
  }
  const kept = values.slice(0, dimensions), norm = Math.hypot(...kept) || 1;
  return kept.map(x => x / norm);
}

// Its sealed values: a call's body, one value, a context, a ticket's life
// in seconds (chest/toolseal).
const sealedBody = 4 << 20, sealedValue = 512 << 10, sealedContext = 256, ticketLife = 60;
const sealedText = /^chest:sealed:1:((?:[a-z][a-z0-9-]{0,47}(?:,[a-z][a-z0-9-]{0,47}){0,15})?):([A-Za-z0-9_-]+)$/u;
// Its events: the keys of an emit, and its envelope beyond the data and
// the identifiers of its audience.
const emitKeys = ["type", "data", "subject", "key", "occurredAt", "audience", "cause"], envelopeBytes = 4096, idBytes = 64;
// canonical is a value's JSON with the keys of each object in order: the
// content an idempotency key stands for, whatever order the tool wrote.
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value !== null && typeof value === "object" ? `{${Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical((value as Record<string, unknown>)[k])).join(",")}}`
  : JSON.stringify(value) ?? "null";
const newId = (prefix: string): string => prefix + Array.from(randomBytes(26), b => "abcdefghijklmnopqrstuvwxyz234567"[b & 31]).join("");

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
// environment names one), and what the Chest is (CHEST_ORGANIZATION,
// CHEST_TIME_ZONE, CHEST_LANGUAGE, as options.chest says). What member(),
// chest and the modules of the SDK read is then this Chest's.
export async function fakeChest(options: FakeChestOptions = {}): Promise<FakeChest> {
  const capabilities = new Set(options.capabilities ?? ["members", "files", "notifications", "ai"]);
  const email = capabilities.has("members.email"), everyGroup = capabilities.has("members.groups");
  const tool = process.env["CHEST_TOOL"] || "tool";
  const token = randomBytes(32).toString("base64url");
  const files = new Map<string, FakeFile>();
  for (const [name, file] of Object.entries(options.files ?? {})) {
    files.set(name, { data: typeof file.data === "string" ? new TextEncoder().encode(file.data) : file.data, type: file.type ?? "application/octet-stream", updated: new Date().toISOString() });
  }
  const receives = options.receives ?? ["member.*"];
  // What the tool's chest.json declares it emits, refused as the Chest
  // refuses the manifest.
  const emits = options.emits ?? {};
  for (const [type, declared] of Object.entries(emits)) {
    const length = typeof declared?.description === "string" ? [...declared.description].length : 0;
    if (!isToolEventType(type) || length < 1 || length > 80 || !object(declared.data) || !Object.entries(declared.data).every(([name, kind]) => fieldNamePattern.test(name) && fieldOf(kind) !== null)) {
      throw new Error(`fakeChest: the Chest refuses "emits" ${JSON.stringify(type)}: a type of two to four dotted words, a description of 1 to 80 characters, camelCase fields of the kinds id, text, number, boolean, time, date, member, members (? when optional)`);
    }
  }
  // The erasures the tool was told of, by deliver: those it may acknowledge.
  const erasures = new Set<string>();
  const realtime = fakeRealtime(options.realtime ?? {}, () => chest.api, id => {
    const m = chest.members.find(x => x.id === id);
    return m ? m.role : undefined;
  });
  const chest: FakeChest = { api: "", token, tool, members: [...(options.members ?? [])], groups: [...(options.groups ?? [])], files, notifications: [], badges: new Map(), acknowledged: [], ai: [], opens: [], realtime: realtime.realtime, emitted: [], deliver: async () => 0, run: async () => 0, close: async () => {} };
  const former = [...(options.former ?? [])];
  let window = 0, calls = 0;
  // The groups the tool sees: those that give it, or all with members.groups;
  // a member's groups among them (an identifier it was not given stays).
  const unseen = () => new Set(everyGroup ? [] : chest.groups.filter(g => g.grants === false).map(g => g.id));
  const groupsOf = (m: Member) => (m.groups ?? []).filter(g => !unseen().has(g));
  const shown = (m: Member) => ({ id: m.id, first_name: m.firstName, last_name: m.lastName, name: m.name, photo: m.photo, role: m.role, admin: m.isAdmin, builder: m.isBuilder, groups: groupsOf(m), language: m.language, time_zone: m.timeZone, ...(email && m.email !== undefined ? { email: m.email } : {}) });
  const key = (m: Member) => fold(m.name) + "\u0000" + m.id;
  const described = (name: string, f: FakeFile) => ({ name, type: f.type, size: f.data.byteLength, sha256: createHash("sha256").update(f.data).digest("hex"), updated: f.updated });

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
        .filter(m => (role === null || m.role === role) && (group === null || groupsOf(m).includes(group)) && (search === "" || [m.firstName, m.lastName, m.name, ...(email && m.email ? [m.email] : [])].some(n => fold(n).startsWith(search))))
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
        else if (f?.status === "erased") answer.former.push({ id, status: "erased" });
        else if (f?.status === "no_access") answer.former.push({ id, name: f.name ?? "Test member", status: "no_access" });
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
    if (request.method === "GET" && url.pathname === "/groups") {
      const q = url.searchParams, keys = [...q.keys()];
      const limit = q.has("limit") ? Number(q.get("limit")) : defaultLimit;
      const after = q.has("after") ? Buffer.from(q.get("after")!, "base64url").toString() : "";
      if ((q.has("after") && !groupIdPattern.test(after.split("\u0000")[1] ?? "")) || keys.some(k => !["after", "limit"].includes(k) || q.getAll(k).length !== 1) || !Number.isInteger(limit) || limit < 1 || limit > maxLimit || String(limit) !== (q.get("limit") ?? String(defaultLimit))) return send(response, 400, { error: "invalid_query" });
      const groupKey = (g: FakeGroup) => fold(g.name) + "\u0000" + g.id;
      const listed = chest.groups.filter(g => !unseen().has(g.id) && (after === "" || groupKey(g) > after)).sort((a, b) => groupKey(a) < groupKey(b) ? -1 : groupKey(a) > groupKey(b) ? 1 : 0);
      const page = listed.slice(0, limit);
      return send(response, 200, { groups: page.map(g => ({ id: g.id, name: g.name, size: g.members.filter(access).length })), next: listed.length > limit ? Buffer.from(groupKey(page.at(-1)!)).toString("base64url") : null });
    }
    send(response, 404, { error: "not_found" });
  }

  async function filesRoute(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (!capabilities.has("files")) return send(response, 403, { error: "capability_not_granted" });
    if (request.method === "GET" && url.pathname === "/files") {
      const prefix = url.searchParams.get("prefix") ?? "", after = url.searchParams.get("after") ?? "";
      const names = [...files.keys()].filter(n => n.startsWith(prefix) && n > after).sort();
      return send(response, 200, { files: names.slice(0, 1000).map(n => described(n, files.get(n)!)), next: names.length > 1000 ? names[999] : null });
    }
    if (request.method === "POST" && (url.pathname === "/files/url" || url.pathname === "/files/move" || url.pathname === "/files/upload-url")) {
      const raw = await body(request, 4096);
      let command: Record<string, unknown> = {};
      try { command = JSON.parse(raw?.toString() ?? "") as Record<string, unknown>; } catch { command = {}; }
      if (url.pathname === "/files/url") {
        const { name, thumbnail, download } = command;
        if (typeof name !== "string" || !(thumbnail === undefined || thumbnail === 256 || thumbnail === 1024) || !(download === undefined || typeof download === "boolean")) return send(response, 400, { error: "invalid_body" });
        const object = files.get(name);
        if (!object) return send(response, 404, { error: "not_found" });
        if (thumbnail !== undefined && !thumbnailed.includes(object.type)) return send(response, 400, { error: "no_thumbnail" });
        const token = newToken();
        links.set(token, { name, object, until: Date.now() + linkLife * 1000, download: download === true });
        return send(response, 200, { url: `${chest.api}${linkPath}${token}`, expires_in: linkLife });
      }
      if (url.pathname === "/files/upload-url") {
        const { name, max_size: maxSize, types, expires_in: expiresIn, public: visitor } = command;
        const folder = typeof name === "string" && name.endsWith("/");
        if (typeof name !== "string" || !namePattern.test(folder ? name.slice(0, -1) : name) || (visitor === true && !folder)) return send(response, 400, { error: "invalid_name" });
        if (!(types === undefined || (Array.isArray(types) && types.length <= 8 && types.every(t => typeof t === "string" && mediaPattern.test(t))))) return send(response, 400, { error: "invalid_type" });
        if (visitor === true && (!Array.isArray(types) || types.length === 0 || !types.every(t => recognised.some(r => accepted([t as string], r))))) return send(response, 400, { error: "invalid_type" });
        if (!(maxSize === undefined || (typeof maxSize === "number" && Number.isSafeInteger(maxSize) && maxSize > 0)) || !(expiresIn === undefined || (typeof expiresIn === "number" && Number.isInteger(expiresIn) && expiresIn > 0 && expiresIn <= uploadLife)) || !(visitor === undefined || typeof visitor === "boolean")) return send(response, 400, { error: "invalid_body" });
        if (visitor === true && process.env["CHEST_PUBLIC_URL"] === undefined) return send(response, 409, { error: "no_public_part" });
        if ((maxSize ?? 0) > maxObject) return send(response, 413, { error: "too_large" });
        const token = newToken(), life = (expiresIn as number | undefined) ?? uploadLife;
        uploads.set(token, { name, maxSize: (maxSize as number | undefined) ?? maxObject, types: (types as string[] | undefined) ?? [], until: Date.now() + life * 1000, visitor: visitor === true });
        return send(response, 200, { url: visitor === true ? uploadPath + token : `${chest.api}${uploadPath}${token}`, method: "PUT", expires_in: life });
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

  // The team host's and the public part's files, on the fake's own origin:
  // a link it signed opens the content it was signed for, for its life, as
  // long as the file is that content — a thumbnail is the image itself, a
  // fake does not reduce it —; an upload token takes one file, once, within
  // its life, up to its size, named by the Chest in a folder: a member's of
  // the types it names, holding the type it says when the fake recognises
  // it; a visitor's of the type its content is among those it names,
  // whatever it says. Nobody's session is checked, nor a visitor's pace:
  // the Chest's own front does that.
  const links = new Map<string, { name: string; object: FakeFile; until: number; download: boolean }>();
  const uploads = new Map<string, { name: string; maxSize: number; types: string[]; until: number; visitor: boolean }>();
  async function front(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (request.method === "GET" && url.pathname.startsWith(linkPath) && !url.pathname.startsWith(uploadPath)) {
      const link = links.get(url.pathname.slice(linkPath.length));
      if (!link || link.until < Date.now() || files.get(link.name) !== link.object) return send(response, 404, { error: "not_found" });
      const headers: Record<string, string> = { "Content-Type": link.object.type, "Content-Length": String(link.object.data.byteLength), "X-Content-Type-Options": "nosniff" };
      if (link.download) headers["Content-Disposition"] = `attachment; filename="${link.name.split("/").pop()}"`;
      return void response.writeHead(200, headers).end(link.object.data);
    }
    if (request.method !== "PUT" || !url.pathname.startsWith(uploadPath)) return send(response, 404, { error: "not_found" });
    const token = url.pathname.slice(uploadPath.length), grant = uploads.get(token);
    uploads.delete(token);
    if (!grant || grant.until < Date.now()) return send(response, 403, { error: "invalid_token" });
    let type = (request.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (!grant.visitor && (!mediaPattern.test(type) || type.endsWith("/*") || (grant.types.length > 0 && !accepted(grant.types, type)))) return send(response, 415, { error: "type_refused" });
    const data = await body(request, grant.maxSize);
    if (data === null) return send(response, 413, { error: "too_large" });
    if (grant.visitor) {
      const found = recognised.find(r => accepted(grant.types, r) && recognisers[r]!(data));
      if (found === undefined) return send(response, 415, { error: "type_refused" });
      type = found;
    } else if (recognisers[type] && !recognisers[type]!(data)) return send(response, 400, { error: "type_mismatch" });
    const name = grant.name.endsWith("/") ? grant.name + randomBytes(10).toString("hex") + (extensions[type] ?? "") : grant.name;
    const total = [...files.entries()].reduce((sum, [n, f]) => n === name ? sum : sum + f.data.byteLength, 0);
    if (total + data.length > maxTotal || (!files.has(name) && files.size >= maxObjects)) return send(response, 429, { error: "quota_exceeded" });
    files.set(name, { data: new Uint8Array(data), type, updated: new Date().toISOString() });
    send(response, 201, { name, type, size: data.length });
  }

  // The windows of a request rate (AI), each from the first call it counts.
  type Window = { start: number; count: number };
  const live = (w: Window | undefined, span: number, now: number): boolean => w !== undefined && w.count > 0 && now - w.start < span;
  const wait = (w: Window, span: number, now: number): Record<string, string> => ({ "Retry-After": String(Math.max(1, Math.ceil((w.start + span - now) / 1000))) });
  const count = (w: Window, span: number, now: number, n: number): void => {
    if (!live(w, span, now)) [w.start, w.count] = [now, 0];
    w.count += n;
  };
  // The pace of each member: a token bucket, as of when it was last used.
  const buckets = new Map<string, { tokens: number; at: number }>();
  const paced = (id: string, now: number): boolean => {
    const b = buckets.get(id) ?? { tokens: paceBurst, at: now };
    b.tokens = Math.min(paceBurst, b.tokens + (now - b.at) / paceEvery);
    b.at = now;
    buckets.set(id, b);
    if (b.tokens < 1) return false;
    b.tokens--;
    return true;
  };
  const access = (id: string) => chest.members.some(m => m.id === id);
  // drop removes kept notifications in place: a test may hold the list.
  const drop = (gone: (n: FakeNotification) => boolean): void => {
    for (let i = chest.notifications.length - 1; i >= 0; i--) if (gone(chest.notifications[i]!)) chest.notifications.splice(i, 1);
  };
  // recipients reads 1 to 500 member identifiers, each once.
  function recipients(value: unknown): string[] | { error: string } {
    if (!Array.isArray(value) || value.length < 1) return { error: "invalid_body" };
    if (!value.every(v => typeof v === "string" && memberIdPattern.test(v))) return { error: "invalid_id" };
    return [...new Set(value as string[])];
  }

  async function notificationsRoute(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (!capabilities.has("notifications")) return send(response, 403, { error: "capability_not_granted" });
    const badge = request.method === "PUT" && url.pathname.startsWith("/badges/");
    if (!badge && !(request.method === "PUT" && url.pathname === "/badges") && !(request.method === "POST" && ["/notifications", "/notifications/broadcast", "/notifications/withdraw"].includes(url.pathname))) return send(response, 404, { error: "not_found" });
    const raw = await body(request, textBytes + memberBytes * chest.members.length);
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
        if (!keys("badges") || !Array.isArray(list) || list.length < 1 || !list.every(b => b !== null && typeof b === "object" && !Array.isArray(b) && Object.keys(b).every(k => k === "member" || k === "count"))) return send(response, 400, { error: "invalid_body" });
        writes = list as { member: string; count: number }[];
        if (!writes.every(b => typeof b.member === "string" && memberIdPattern.test(b.member))) return send(response, 400, { error: "invalid_id" });
      }
      if (!writes.every(b => typeof b.count === "number" && Number.isInteger(b.count) && b.count >= 0 && b.count <= maxCount)) return send(response, 400, { error: "invalid_count" });
      if (new Set(writes.map(b => b.member)).size !== writes.length) return send(response, 400, { error: "invalid_body" });
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
    const broadcast = url.pathname === "/notifications/broadcast";
    if (!keys(broadcast ? "to" : "members", ...(broadcast ? ["except"] : []), "title", "body", "path", "key", "translations")) return send(response, 400, { error: "invalid_body" });
    let ids: string[];
    if (broadcast) {
      const to = command!["to"] as Record<string, unknown> | undefined, except = command!["except"];
      if (to !== undefined && (to === null || typeof to !== "object" || Array.isArray(to) || !Object.keys(to).every(k => k === "groups" || k === "roles"))) return send(response, 400, { error: "invalid_body" });
      const groups = to?.["groups"] ?? [], roles = to?.["roles"] ?? [];
      if (!Array.isArray(groups) || !Array.isArray(roles) || (to !== undefined && groups.length + roles.length === 0) || roles.length > maxRoles || (except !== undefined && !Array.isArray(except))) return send(response, 400, { error: "invalid_body" });
      if (!groups.every(g => typeof g === "string" && groupIdPattern.test(g)) || !((except ?? []) as unknown[]).every(id => typeof id === "string" && memberIdPattern.test(id))) return send(response, 400, { error: "invalid_id" });
      if (!roles.every(r => typeof r === "string" && rolePattern.test(r))) return send(response, 400, { error: "invalid_role" });
      ids = chest.members.filter(m => !((except ?? []) as string[]).includes(m.id) && (to === undefined || (m.role !== null && roles.includes(m.role)) || groupsOf(m).some(g => groups.includes(g)))).map(m => m.id);
    } else {
      const named = recipients(command!["members"]);
      if (!Array.isArray(named)) return send(response, 400, named);
      ids = named;
    }
    const { path, key, translations } = command!;
    const words = (value: unknown): { title: string; body?: string } | { error: string } => {
      const { title, body: text, ...rest } = (value ?? {}) as Record<string, unknown>;
      if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(rest).length > 0 || title === undefined) return { error: "invalid_body" };
      if (typeof title !== "string" || [...title].length < 1 || [...title].length > maxTitle || cleanTitle(title) === "") return { error: "invalid_title" };
      if (text !== undefined && (typeof text !== "string" || [...text].length > maxText)) return { error: "invalid_text" };
      const cleaned = typeof text === "string" ? cleanText(text) : "";
      return { title: cleanTitle(title), ...(cleaned ? { body: cleaned } : {}) };
    };
    const own = words({ title: command!["title"], ...(command!["body"] !== undefined ? { body: command!["body"] } : {}) });
    if ("error" in own) return send(response, 400, own);
    if (path !== undefined && !isPath(path)) return send(response, 400, { error: "invalid_path" });
    if (key !== undefined && (typeof key !== "string" || !keyPattern.test(key))) return send(response, 400, { error: "invalid_key" });
    const other = new Map<string, { title: string; body?: string }>();
    if (translations !== undefined) {
      if (translations === null || typeof translations !== "object" || Array.isArray(translations)) return send(response, 400, { error: "invalid_body" });
      for (const [language, value] of Object.entries(translations)) {
        if (!languagePattern.test(language)) return send(response, 400, { error: "invalid_language" });
        const translated = words(value);
        if ("error" in translated) return send(response, 400, translated);
        other.set(language, translated);
      }
    }
    const kept = ids.filter(access);
    for (const id of kept) {
      const language = chest.members.find(m => m.id === id)!.language;
      const item: FakeNotification = { member: id, ...(other.get(language) ?? own), path: (path as string | undefined) ?? "/chest", ...(key !== undefined ? { key: key as string } : {}) };
      if (key !== undefined && chest.notifications.some(n => n.member === id && n.key === key)) drop(n => n.member === id && n.key === key);
      else if (!paced(id, now)) {
        // Beyond the pace: folded into the member's grouped item, never refused.
        const grouped = chest.notifications.find(n => n.member === id && n.grouped !== undefined);
        drop(n => n === grouped);
        delete item.key;
        item.grouped = (grouped?.grouped ?? 0) + 1;
      }
      chest.notifications.push(item);
    }
    if (broadcast) return send(response, 204);
    send(response, 200, { delivered: kept, skipped: ids.filter(id => !access(id)) });
  }

  // Its AI: the declared aliases, the spending this month, the requests this
  // minute.
  const mapped = (options.ai?.models ?? aliasOrder.map((alias): FakeAiModel => ({ alias, model: "fake-" + alias }))).map(m => ({ alias: m.alias, model: m.model, provider: m.provider ?? "openrouter", input: m.input ?? 1, output: m.output ?? 2 }));
  const cap = options.ai?.cap ?? 5;
  const aiMinute: Window = { start: 0, count: 0 };
  let spent = 0;
  const month = () => new Date().toISOString().slice(0, 7);
  const resets = () => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().replace(".000Z", "Z");
  };
  const spend = (m: { input: number; output: number }, input: number, output: number): number => {
    const cost = Math.round((input * m.input + output * m.output) / 1e6 * 1e6) / 1e6;
    spent = Math.round((spent + cost) * 1e6) / 1e6;
    return cost;
  };
  // echo is the text of the last user message: its text, or its text parts.
  const echo = (request: Record<string, unknown>): string => {
    const last = [...request["messages"] as { role?: unknown; content?: unknown }[]].reverse().find(m => m?.role === "user")?.content;
    return typeof last === "string" ? last : Array.isArray(last) ? last.map(p => (p as { text?: unknown })?.text).filter(t => typeof t === "string").join("") : "";
  };

  async function aiRoute(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const raw = request.method === "POST" ? await body(request, maxAiBody) : null;
    let command: Record<string, unknown> | null = null;
    try {
      const value = JSON.parse(raw?.toString() ?? "") as unknown;
      if (value !== null && typeof value === "object" && !Array.isArray(value)) command = value as Record<string, unknown>;
    } catch {
      command = null;
    }
    chest.ai.push({ path: url.pathname, body: command });
    if (!capabilities.has("ai")) return send(response, 403, { error: "capability_not_granted" });
    if (request.method === "GET" && url.pathname === "/ai/models") return send(response, 200, { models: [...mapped].sort((a, b) => aliasOrder.indexOf(a.alias) - aliasOrder.indexOf(b.alias)) });
    if (request.method === "GET" && url.pathname === "/ai/usage") return send(response, 200, { month: month(), spent, cap, resets: resets() });
    if (request.method !== "POST" || (url.pathname !== "/ai/chat" && url.pathname !== "/ai/embeddings")) return send(response, 404, { error: "not_found" });
    if (raw === null) return send(response, 413, { error: "too_large" });
    const chat = url.pathname === "/ai/chat";
    if (!command || !Object.keys(command).every(k => chat ? chatKeys.includes(k) : ["model", "input", "dimensions", "member"].includes(k))) return send(response, 400, { error: "invalid_body" });
    const model = mapped.find(m => m.alias === command!["model"]);
    if (!model) return send(response, 403, { error: "model_not_allowed" });
    const member = command["member"];
    if (member !== undefined && (typeof member !== "string" || !memberIdPattern.test(member))) return send(response, 400, { error: "invalid_body" });
    const now = Date.now();
    // refused says the refusal of a valid request, if any: the rate, the
    // provider, the cap.
    const refused = (): boolean => {
      const busy = live(aiMinute, 60_000, now) && aiMinute.count >= aiPerMinute;
      if (busy) send(response, 429, { error: "rate_limited" }, wait(aiMinute, 60_000, now));
      else {
        count(aiMinute, 60_000, now, 1);
        if (options.ai?.unavailable) send(response, options.ai.unavailable === "provider_key_invalid" ? 502 : 503, { error: options.ai.unavailable });
        else if (spent >= cap) send(response, 402, { error: "cap_reached", scope: "tool", resets: resets() });
      }
      return response.headersSent;
    };
    if (!chat) {
      const input = command["input"], texts = typeof input === "string" ? [input] : input, dimensions = command["dimensions"] ?? fakeDimensions;
      if (!Array.isArray(texts) || texts.length < 1 || texts.length > maxInputs || !texts.every(t => typeof t === "string") || typeof dimensions !== "number" || !Number.isInteger(dimensions) || dimensions < 1 || dimensions > 4096) return send(response, 400, { error: "invalid_body" });
      if (refused()) return;
      const used = texts.reduce((sum: number, t: string) => sum + tokensOf(t), 0);
      const cost = spend(model, used, 0);
      return send(response, 200, { object: "list", data: texts.map((t: string, index) => ({ object: "embedding", index, embedding: vectorOf(t, dimensions) })), model: model.model, usage: { prompt_tokens: used, total_tokens: used, cost } });
    }
    const messages = command["messages"], limit = command["max_tokens"] ?? 4096;
    if (!Array.isArray(messages) || messages.length < 1 || !messages.every(m => m !== null && typeof m === "object" && typeof (m as { role?: unknown }).role === "string") || typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > maxAiOutput || !(command["stream"] === undefined || typeof command["stream"] === "boolean")) return send(response, 400, { error: "invalid_body" });
    if (refused()) return;
    const given = options.ai?.reply ? options.ai.reply(command) : echo(command);
    const text = typeof given === "string" ? given : given.text ?? "";
    const calls = (typeof given === "string" ? [] : given.toolCalls ?? []).map((c, i) => ({ id: c.id ?? `call_${i + 1}`, type: "function" as const, function: { name: c.name, arguments: c.arguments } }));
    const input = tokensOf(JSON.stringify(messages)), output = tokensOf(text + calls.map(c => c.function.name + c.function.arguments).join(""));
    const usage = { prompt_tokens: input, completion_tokens: output, total_tokens: input + output, prompt_tokens_details: { cached_tokens: 0 }, cost: spend(model, input, output) };
    const finish = calls.length ? "tool_calls" : "stop";
    const head = { id: "chatcmpl-fake", created: Math.floor(now / 1000), model: model.model };
    if (command["stream"] !== true) {
      return send(response, 200, { ...head, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: calls.length && !text ? null : text, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: finish }], usage });
    }
    // Streamed: the role, the text word by word, each call's name then its
    // arguments in two halves, the finish reason, the usage, [DONE].
    const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) => `data: ${JSON.stringify({ ...head, object: "chat.completion.chunk", choices, ...extra })}\n\n`;
    const delta = (d: Record<string, unknown>, finishReason: string | null = null) => chunk([{ index: 0, delta: d, finish_reason: finishReason }]);
    const parts = [delta({ role: "assistant", content: "" })];
    for (const word of text.match(/\S+\s*|\s+/gu) ?? []) parts.push(delta({ content: word }));
    calls.forEach((c, index) => {
      const half = Math.ceil(c.function.arguments.length / 2);
      parts.push(delta({ tool_calls: [{ index, id: c.id, type: "function", function: { name: c.function.name, arguments: "" } }] }));
      for (const piece of [c.function.arguments.slice(0, half), c.function.arguments.slice(half)]) if (piece) parts.push(delta({ tool_calls: [{ index, function: { arguments: piece } }] }));
    });
    parts.push(delta({}, finish), chunk([], { usage }), "data: [DONE]\n\n");
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    for (const part of parts) response.write(part);
    response.end();
  }

  // Its sealed values: AES-256-GCM under a key of its own — the format and
  // the rules of a Chest, not its cipher —, bound to the tool, the roles
  // and the context; its tickets, HMAC under another, for 60 seconds.
  const sealingKey = randomBytes(32), ticketKey = randomBytes(32);
  const additional = (roles: string, context: string) => Buffer.from(`chest:sealed:1:\u0000${tool}\u0000${roles}\u0000${context}`);
  const ticketMac = (id: string, expiry: string) => createHmac("sha256", ticketKey).update(`${id}\u0000${expiry}`).digest();
  ticketOf = id => { const expiry = String(Math.floor(Date.now() / 1000) + ticketLife); return `1.${id}.${expiry}.${ticketMac(id, expiry).toString("base64url")}`; };
  const ticketMember = (ticket: string | string[] | undefined): string | null => {
    const parts = typeof ticket === "string" ? ticket.split(".") : [];
    if (parts.length !== 4 || parts[0] !== "1" || !memberIdPattern.test(parts[1]!) || Number(parts[2]) < Date.now() / 1000) return null;
    const mac = Buffer.from(parts[3]!, "base64url"), expected = ticketMac(parts[1]!, parts[2]!);
    return mac.length === expected.length && timingSafeEqual(mac, expected) ? parts[1]! : null;
  };
  const isContext = (c: unknown): c is string | undefined => c === undefined || (typeof c === "string" && Buffer.byteLength(c) <= sealedContext);
  async function sealedRoute(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (!capabilities.has("sealed")) return send(response, 403, { error: "capability_not_granted" });
    if (request.method !== "POST" || url.search || (url.pathname !== "/sealed/seal" && url.pathname !== "/sealed/open")) return send(response, 404, { error: "not_found" });
    const id = url.pathname === "/sealed/open" ? ticketMember(request.headers["chest-opener"]) : null;
    if (url.pathname === "/sealed/open" && id === null) return send(response, 401, { error: "member_required" });
    const raw = await body(request, sealedBody);
    if (raw === null) return send(response, 413, { error: "too_large" });
    let items: unknown;
    try { items = (JSON.parse(raw.toString()) as { items?: unknown }).items; } catch { items = undefined; }
    if (!Array.isArray(items)) return send(response, 400, { error: "invalid_body" });
    if (url.pathname === "/sealed/seal") {
      const sealed: string[] = [];
      for (const item of items as { value?: unknown; roles?: unknown; context?: unknown }[]) {
        if (typeof item?.value !== "string" || Buffer.byteLength(item.value) > sealedValue || !isContext(item.context)) return send(response, 400, { error: "invalid_body" });
        const roles = item.roles;
        if (roles !== undefined && (!Array.isArray(roles) || roles.length === 0 || roles.length > maxRoles || !roles.every(r => typeof r === "string" && rolePattern.test(r) && (!options.roles || options.roles.includes(r))) || new Set(roles).size !== roles.length)) return send(response, 400, { error: "invalid_role" });
        const joined = (roles as string[] | undefined)?.join(",") ?? "", nonce = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", sealingKey, nonce).setAAD(additional(joined, item.context ?? ""));
        const box = Buffer.concat([nonce, cipher.update(item.value, "utf8"), cipher.final(), cipher.getAuthTag()]);
        sealed.push(`chest:sealed:1:${joined}:${box.toString("base64url")}`);
      }
      return send(response, 200, { sealed });
    }
    const holder = chest.members.find(m => m.id === id);
    if (!holder) return send(response, 403, { error: "access_removed" });
    const values: ({ value: string } | { refused: "role" | "invalid" })[] = [];
    for (const item of items as { sealed?: unknown; context?: unknown }[]) {
      if (typeof item?.sealed !== "string" || !isContext(item.context)) return send(response, 400, { error: "invalid_body" });
      const found = sealedText.exec(item.sealed), box = found ? Buffer.from(found[2]!, "base64url") : Buffer.alloc(0);
      let value: string | null = null;
      if (found && box.length >= 28) {
        try {
          const decipher = createDecipheriv("aes-256-gcm", sealingKey, box.subarray(0, 12)).setAAD(additional(found[1]!, item.context ?? ""));
          decipher.setAuthTag(box.subarray(box.length - 16));
          value = Buffer.concat([decipher.update(box.subarray(12, box.length - 16)), decipher.final()]).toString("utf8");
        } catch { value = null; }
      }
      const roles = found?.[1] ? found[1].split(",") : [];
      values.push(value === null ? { refused: "invalid" } : roles.length && !roles.includes(holder.role ?? "") ? { refused: "role" } : { value });
    }
    if (values.length) chest.opens.push({ member: holder.id, opened: values.filter(v => "value" in v).length, refused: values.filter(v => "refused" in v).length });
    send(response, 200, { values });
  }

  // The acknowledgment of an erasure the tool was told of (deliver).
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

  // Realtime: the tool's API, and the probe of a page that asks whether its
  // member may connect.
  async function realtimeRoute(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (!capabilities.has("realtime")) return send(response, url.pathname === "/_chest/realtime" ? 404 : 403, url.pathname === "/_chest/realtime" ? undefined : { error: "capability_not_granted" });
    if (url.pathname === "/_chest/realtime") return realtime.probe(response, url, send);
    return realtime.api(request, response, url, body, send);
  }

  // The events the tool emits (POST /events), checked against its "emits"
  // as the Chest checks them: a member it never had, a group it does not
  // know, are refused; an idempotency key used within 72 hours answers its
  // first event for the same content, key_reused for other content.
  const used = new Map<string, { id: string; content: string; at: number }>();
  const had = (id: string): boolean => access(id) || former.some(f => f.id === id);
  async function eventsRoute(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (request.method !== "POST" || url.pathname !== "/events" || url.search) return send(response, 404, { error: "not_found" });
    if (Object.keys(emits).length === 0) return send(response, 403, { error: "capability_not_granted" });
    // The data, the envelope, and an audience of as many identifiers as the Chest holds.
    const raw = await body(request, maxData + envelopeBytes + idBytes * (chest.members.length + former.length + chest.groups.length + maxRoles));
    if (raw === null) return send(response, 413, { error: "too_large" });
    const command = object(json(raw.toString("utf8")));
    if (!command || !Object.keys(command).every(k => emitKeys.includes(k))) return send(response, 400, { error: "invalid_event" });
    const { type, data, subject, key, occurredAt, audience, cause } = command;
    if (!isToolEventType(type) || !Object.hasOwn(emits, type)) return send(response, 400, { error: "invalid_type" });
    const now = Date.now(), time = occurredAt === undefined ? now : instantOf(occurredAt);
    const identifier = (value: unknown, pattern: RegExp): boolean => value === undefined || (typeof value === "string" && pattern.test(value));
    if (!identifier(subject, itemIdPattern) || !identifier(key, itemIdPattern) || !identifier(cause, eventChannel.id) || time === null || time > now + clockSkew || time < now - eventWindow) return send(response, 400, { error: "invalid_event" });
    if (Buffer.byteLength(JSON.stringify(data) ?? "") > maxData) return send(response, 413, { error: "too_large" });
    if (!isDeclaredData(data, emits[type]!.data, had)) return send(response, 400, { error: "invalid_data" });
    if (audience !== undefined && (!isAudience(audience) || !(audience.members ?? []).every(had) || !(audience.groups ?? []).every(g => chest.groups.some(x => x.id === g)))) return send(response, 400, { error: "invalid_audience" });
    const content = canonical({ type, data, subject, occurredAt, audience });
    const first = key === undefined ? undefined : used.get(key as string);
    if (first && now - first.at < eventWindow) return first.content === content ? send(response, 200, { id: first.id, receivers: 0 }) : send(response, 409, { error: "key_reused" });
    const id = newId("evt_");
    if (key !== undefined) used.set(key as string, { id, content, at: now });
    chest.emitted.push({
      id, type, data: data as Record<string, unknown>, ...(subject === undefined ? {} : { subject: subject as string }), ...(key === undefined ? {} : { key: key as string }),
      occurredAt: (occurredAt as string | undefined) ?? new Date(now).toISOString(), ...(audience === undefined ? {} : { audience }), ...(cause === undefined ? {} : { cause: cause as string }),
    });
    send(response, 202, { id, receivers: 0 });
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const route = url.pathname === "/_chest/realtime" || url.pathname.startsWith("/realtime/") ? realtimeRoute
      : url.pathname.startsWith("/_chest/files/") ? front
      : url.pathname.startsWith("/erasures/") ? erasuresRoute
      : url.pathname === "/events" ? eventsRoute
      : url.pathname.startsWith("/ai/") ? aiRoute
      : url.pathname.startsWith("/sealed/") ? sealedRoute
      : url.pathname === "/members" || url.pathname.startsWith("/members/") || url.pathname === "/groups" ? members
      : url.pathname === "/files" || url.pathname.startsWith("/files/") ? filesRoute
      : url.pathname === "/badges" || url.pathname.startsWith("/badges/") || url.pathname.startsWith("/notifications") ? notificationsRoute : null;
    if (!route) return send(response, 404, { error: "not_found" });
    route(request, response, url).catch(() => { if (!response.headersSent) send(response, 503, { error: "unavailable" }); else response.destroy(); });
  });
  // A page's connection: the Chest's side of the browser client.
  server.on("upgrade", (request: IncomingMessage, socket: Duplex) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/_chest/realtime" || !capabilities.has("realtime")) return void socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
    realtime.upgrade(request, socket, url);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const saved = Object.fromEntries(["CHEST_API", "CHEST_TOKEN", "CHEST_TOOL", "CHEST_ORGANIZATION", "CHEST_TIME_ZONE", "CHEST_LANGUAGE", "CHEST_CURRENCY", "CHEST_TEAM_URL", "CHEST_PUBLIC_URL"].map(name => [name, process.env[name]]));
  chest.api = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  // Its links are on its own origin, the CHEST_API it sets: the files
  // module takes them there (api.ts, chestLink), in this process or in a
  // tool it starts with this environment.
  const publicUrl = options.chest?.publicUrl === undefined ? `https://${tool}.chest.test` : options.chest.publicUrl;
  Object.assign(process.env, { CHEST_API: chest.api, CHEST_TOKEN: token, CHEST_TOOL: tool, CHEST_ORGANIZATION: options.chest?.organization ?? "Test organization", CHEST_TIME_ZONE: options.chest?.timeZone ?? "UTC", CHEST_LANGUAGE: options.chest?.language ?? "en", CHEST_CURRENCY: options.chest?.currency ?? "EUR", CHEST_TEAM_URL: options.chest?.teamUrl ?? `https://${tool}-chest.chest.test` });
  if (publicUrl === null) delete process.env["CHEST_PUBLIC_URL"];
  else process.env["CHEST_PUBLIC_URL"] = publicUrl;
  forget();
  // post delivers what the Chest posts to the tool on a channel — at its
  // address, or to a handler — and says the status it answered.
  const post = async (path: string, channel: Channel, id: string, body: string, to: string | ((request: Request) => Response | Promise<Response>)): Promise<number> => {
    const request = new Request((typeof to === "string" ? to.replace(/\/$/u, "") : "http://tool.test") + path, { method: "POST", headers: { "Content-Type": "application/json", [channel.header]: sign(channel, id, body, { token, tool }) }, body });
    const answer = typeof to === "string" ? await fetch(request, { redirect: "manual" }) : await to(request);
    await answer.body?.cancel();
    return answer.status;
  };
  chest.deliver = async (event, to) => {
    const id = event.id ?? newId("evt_"), occurredAt = event.occurredAt ?? new Date().toISOString();
    if ("source" in event) {
      const body = JSON.stringify({ id, type: event.type, source: event.source, occurredAt, ...(event.subject === undefined ? {} : { subject: event.subject }), audience: event.audience ?? "all", data: event.data });
      return post("/chest-events", eventChannel, id, body, to);
    }
    if (event.type === "member.erased") erasures.add(event.data.erasure);
    return post("/chest-events", eventChannel, id, JSON.stringify({ id, type: event.type, occurredAt, data: event.data }), to);
  };
  chest.run = async (name, to, run = {}) => {
    const id = run.id ?? newId("run_");
    const body = JSON.stringify({ id, name, scheduledAt: run.scheduledAt ?? new Date().toISOString(), attempt: run.attempt ?? 1 });
    return post("/chest-schedules", scheduleChannel, id, body, to);
  };
  chest.close = async () => {
    realtime.close();
    ticketOf = null;
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
