import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage } from "node:http";
import { ask, json as readJson, refusal } from "./api.js";
import { ChestError, TooLarge, Unavailable } from "./errors.js";
import { clockSkew, eventWindow, instantOf, isAudience, isToolEventType, itemIdPattern, maxData, toolNamePattern, type Audience } from "./eventrules.js";
import { memberIdPattern } from "./member.js";
import { forget } from "./members.js";
import { delivery, eventChannel, instant, json, memorySeen, object, type Seen } from "./signed.js";

// What the Chest tells a server tool, and what the tool tells other tools
// of its Chest, on one route. Two kinds of events come to the tool's POST
// /chest-events, through its launcher only (never from the Internet),
// signed for this tool:
//
// - its members' lifecycle (member.updated, access.revoked, member.removed,
//   member.erased), for a tool whose chest.json declares "capabilities":
//   ["members"] and "receives": ["member.*"];
// - events between tools: those another tool of the Chest emits
//   ("quote.accepted"), for a tool whose chest.json "receives" names their
//   type, once the owner approved the link between the two tools.
//
//   // app/chest-events/route.ts (Next.js): outside /chest, never behind a session
//   import * as events from "@argentic/chest-sdk/events";
//   export async function POST(request: Request) {
//     return new Response(null, { status: await events.handle(request, {
//       "member.erased": async e => { await anonymise(e.data.id); await events.acknowledgeErasure(e.data.erasure); },
//       "access.revoked": e => unassign(e.data.id),
//       "quote.accepted": e => createProject(e.data, e.audience),
//     }, { seen }) });
//   }
//
// A tool tells the others with emit, for the types its chest.json declares
// in "emits", each with the fields its data carries:
//
//   await events.emit("quote.accepted", { quote: q.id, total: q.total }, { subject: q.id, key: `accepted:${q.id}` });
//
// Delivery is at least once: the same event may come again, always with the
// same id — handle() drops what the store of seen ids already holds. Tool
// events of one subject come in the order emitted; nothing else is ordered.
// An event the tool does not answer with a success is delivered again,
// after a growing delay, for 72 hours; after that a member event leaves the
// tool out of sync (it reconciles by listing its members, members.list, at
// its next start) and a tool event is kept as a failed delivery an admin
// may send again. Every member event also empties what members.lookup keeps.

// What changed of a member the tool sees; "email" only with members.email;
// "language" and "timeZone": the language the Chest speaks to them and the
// zone they work in — what the tool writes to them, and at what hour.
export type MemberChange = "name" | "photo" | "role" | "groups" | "email" | "language" | "timeZone";
// Something the tool sees of a member who has it changed.
export type MemberUpdated = { id: string; type: "member.updated"; occurredAt: string; data: { id: string; changed: MemberChange[] } };
// The member lost access to the tool but stays in the Chest.
export type AccessRevoked = { id: string; type: "access.revoked"; occurredAt: string; data: { id: string } };
// The member left the Chest: members.lookup reads them "former".
export type MemberRemoved = { id: string; type: "member.removed"; occurredAt: string; data: { id: string } };
// The owner asked for this person's data to be erased: delete or anonymise
// what the tool keeps of them before deadline, then acknowledgeErasure(erasure).
export type MemberErased = { id: string; type: "member.erased"; occurredAt: string; data: { id: string; erasure: string; deadline: string } };
// An event of the members' lifecycle, told apart by its type.
export type ChestEvent = MemberUpdated | AccessRevoked | MemberRemoved | MemberErased;
export type ChestEventType = ChestEvent["type"];

// An event another tool of the Chest told (emit): its id ("evt_…", the same
// on every delivery of it), its type, the tool that told it (source, stamped
// by the Chest), when it happened, the thing it is about (subject, when the
// publisher named one), who may see it, and its data — the fields its type
// declares in the publisher's chest.json, member ids for people. audience is
// "all" when every member who has this tool may see the item, otherwise
// the members of this tool who may: show it to them only (the Chest never
// delivers an item none of them may see; honouring the list is the tool's
// rule). Read data defensively: a publisher's later version may add fields.
export type ToolEvent = { id: string; type: string; source: string; occurredAt: string; subject?: string; audience: "all" | string[]; data: Record<string, unknown> };
// What a delivery carries: an event of the members' lifecycle, or of a tool.
export type ReceivedEvent = ChestEvent | ToolEvent;

// The type of an event between tools as a handler is keyed: dotted words.
export type ToolEventType = `${string}.${string}`;
// What handle() calls for an event of type K: the event of the members'
// lifecycle of that type, or a tool event.
export type Handler<K extends string> = (event: K extends ChestEventType ? Extract<ChestEvent, { type: K }> : ToolEvent) => void | Promise<void>;
// What handle() calls for each type — a member type ("access.revoked"),
// given its own event, or a type of another tool ("quote.accepted"), given a
// ToolEvent; a type left out is accepted and ignored.
export type Handlers<K extends ToolEventType = ChestEventType | ToolEventType> = { [P in K]?: Handler<P> };

// Where handle() remembers the ids of the events already handled (Seen), and
// memorySeen, which keeps them in this process: shared with schedules.
export { memorySeen, type Seen } from "./signed.js";

// The grammar of an erasure's identifier, as the Chest mints it.
export const erasureIdPattern = /^era_[a-z2-7]{26}$/u;
const changes: readonly string[] = ["name", "photo", "role", "groups", "email", "language", "timeZone"];

// memberEvent reads the envelope of a member event (its four keys): the
// event when it is one this SDK reads, known false for a type of a later
// Chest, null for one its type cannot say.
function memberEvent(e: Record<string, unknown>, id: string): { event: ChestEvent; known: true } | { known: false } | null {
  if (Object.keys(e).length !== 4 || typeof e["type"] !== "string" || !instant(e["occurredAt"])) return null;
  const data = object(e["data"]);
  if (!data || typeof data["id"] !== "string" || !memberIdPattern.test(data["id"])) return null;
  const keys = Object.keys(data).sort().join(",");
  const base = { id, occurredAt: e["occurredAt"] as string };
  switch (e["type"]) {
    case "member.updated": {
      const changed = data["changed"];
      if (keys !== "changed,id" || !Array.isArray(changed) || changed.length < 1 || changed.length > changes.length || !changed.every(c => typeof c === "string" && changes.includes(c)) || new Set(changed).size !== changed.length) return null;
      return { known: true, event: { ...base, type: "member.updated", data: { id: data["id"], changed: [...changed] as MemberChange[] } } };
    }
    case "access.revoked":
    case "member.removed":
      return keys === "id" ? { known: true, event: { ...base, type: e["type"], data: { id: data["id"] } } } : null;
    case "member.erased":
      if (keys !== "deadline,erasure,id" || typeof data["erasure"] !== "string" || !erasureIdPattern.test(data["erasure"]) || !instant(data["deadline"])) return null;
      return { known: true, event: { ...base, type: "member.erased", data: { id: data["id"], erasure: data["erasure"], deadline: data["deadline"] as string } } };
  }
  // A type of a later Chest: signed, so the tool accepts it, and ignores it.
  return { known: false };
}

const toolKeys = new Set(["id", "type", "source", "occurredAt", "subject", "audience", "data"]);
// toolEvent reads the envelope of a tool event: its keys exactly, subject
// only when the publisher named one; null for anything else.
function toolEvent(e: Record<string, unknown>, id: string): ToolEvent | null {
  const { type, source, occurredAt, subject, audience } = e, data = object(e["data"]);
  if (Object.keys(e).length !== toolKeys.size - (subject === undefined ? 1 : 0) || !Object.keys(e).every(k => toolKeys.has(k))) return null;
  if (!isToolEventType(type) || typeof source !== "string" || !toolNamePattern.test(source) || instantOf(occurredAt) === null || !data) return null;
  if (subject !== undefined && (typeof subject !== "string" || !itemIdPattern.test(subject))) return null;
  const all = audience === "all";
  if (!all && (!Array.isArray(audience) || audience.length === 0 || !audience.every(m => typeof m === "string" && memberIdPattern.test(m)) || new Set(audience).size !== audience.length)) return null;
  return { id, type, source, occurredAt: occurredAt as string, ...(subject === undefined ? {} : { subject }), audience: all ? "all" : [...audience as string[]], data };
}

// envelope reads a signed delivery: the event when the signature, the tool,
// the time and the digest of the body hold and the envelope is one of a
// member event or of a tool event (it carries a source); known false for a
// member event of a type this SDK does not read.
async function envelope(request: IncomingMessage | Request): Promise<{ event: ReceivedEvent; known: true } | { known: false } | null> {
  const signed = await delivery(request, eventChannel);
  if (!signed) return null;
  const e = object(json(signed.body.toString("utf8")));
  if (!e || e["id"] !== signed.id) return null;
  if (!Object.hasOwn(e, "source")) return memberEvent(e, signed.id);
  const event = toolEvent(e, signed.id);
  return event ? { known: true, event } : null;
}

// verify returns the event a delivery carries, or null when it is not one
// the Chest made for this tool — no or another signature, for another tool,
// expired, a body that is not the one signed, not a POST — or when it is a
// member event of a type this SDK does not know. It reads the body (32 MiB
// at most, once its signature holds: a tool event names who may see it,
// up to a whole team): call it before anything else reads it. It never
// throws for what a request carries.
export async function verify(request: IncomingMessage | Request): Promise<ReceivedEvent | null> {
  const read = await envelope(request);
  return read?.known ? read.event : null;
}

const remembered = memorySeen();
// The event whose handler runs: an emit made while it runs continues its
// chain (cause), so that the Chest cuts a loop between tools.
const handling = new AsyncLocalStorage<string>();

// handle verifies one delivery and hands the event to its handler, once:
// the status to answer the Chest. 401 for a delivery that is not the
// Chest's; 204 for an event handled, one already seen (seen.has), a type
// without a handler or a member type this SDK does not know. A handler that
// throws leaves the event unseen and handle throws: answer 500, the Chest
// delivers it again. seen is the store of the ids handled (memorySeen by
// default, lost at a restart: give a durable one). An emit made by the
// handler of a tool event carries that event as its cause, by itself.
export async function handle<K extends ToolEventType>(request: IncomingMessage | Request, handlers: Handlers<K>, options: { seen?: Seen } = {}): Promise<number> {
  const read = await envelope(request);
  if (!read) return 401;
  if (!read.known) return 204;
  const seen = options.seen ?? remembered;
  const event = read.event;
  if (await seen.has(event.id)) return 204;
  const handler = Object.hasOwn(handlers, event.type) ? (handlers as Record<string, ((e: ReceivedEvent) => void | Promise<void>) | undefined>)[event.type] : undefined;
  if ("source" in event) {
    if (handler) await handling.run(event.id, () => handler(event));
  } else {
    // A member changed or left: what lookup kept of them is stale.
    forget();
    if (handler) await handler(event);
  }
  await seen.add(event.id);
  return 204;
}

// Who, in the tool, may see the item an event is about: some of its
// members, the members of some groups, the members holding some of its
// roles (chest.json "roles"); left out, everyone who has the tool.
export type EmitAudience = Audience;
// What an emit may say besides its type and data: the thing it is about
// (subject, an identifier of the tool's own: a receiver gets one subject's
// events in the order emitted), an idempotency key (the same key within 72
// hours answers the same event, told once), when it happened (now by
// default; within the last 72 hours), and its audience.
export type EmitOptions = { subject?: string; key?: string; occurredAt?: Date | string; audience?: EmitAudience };
// What the Chest answers an emit: the event's id, and how many tools it was
// written for (0 is no error: no installed tool listens, or none of their
// members may see it).
export type Emitted = { id: string; receivers: number };

// audienceOf is the audience as the Chest takes it: each list once per
// identifier, empty lists left out; invalid_audience when it names nobody
// or an identifier of no grammar.
function audienceOf(given: EmitAudience): Audience {
  const audience = object(given) && Object.fromEntries(Object.entries(given).filter(([, list]) => !Array.isArray(list) || list.length > 0).map(([name, list]) => [name, Array.isArray(list) ? [...new Set(list)] : list]));
  if (!isAudience(audience)) throw new ChestError("invalid_audience", 400, "an audience names members (mbr_…), groups (grp_…) or roles of the tool, one at least");
  return audience;
}

// emit tells the tools of the Chest that receive its type that something
// happened in this tool: type is one its chest.json declares in "emits",
// data its declared fields (16 KiB of JSON at most). The Chest writes it
// for each linked receiver before answering, and delivers it at least once.
// Emitted from a handler of a tool event, it continues that event's chain
// by itself (the Chest tells nobody an event that would loop). Errors:
// ChestError invalid_type (400: not declared in "emits", or not a type),
// invalid_data (400: a field not declared, missing or of another kind, a
// member the tool never had), invalid_audience (400), invalid_event (400:
// subject, key or occurredAt), key_reused (409: the key went with other
// content); TooLarge (413), CapabilityNotGranted (403: the version emits
// nothing), Unavailable (the event may or may not be told: emit again with
// the same key).
export async function emit(type: string, data: Record<string, unknown>, options: EmitOptions = {}): Promise<Emitted> {
  if (!isToolEventType(type)) throw new ChestError("invalid_type", 400, "a type is two to four dotted lowercase words (quote.accepted), not member.* nor access.*");
  if (!object(data)) throw new ChestError("invalid_data", 400, "data is an object of the fields the type declares");
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(data));
  } catch {
    throw new ChestError("invalid_data", 400, "data is not JSON");
  }
  if (size > maxData) throw new TooLarge();
  const { subject, key, occurredAt, audience } = options;
  for (const id of [subject, key]) {
    if (id !== undefined && (typeof id !== "string" || !itemIdPattern.test(id))) throw new ChestError("invalid_event", 400, "a subject or a key is 1 to 128 letters, digits and . _ : -, starting with a letter or a digit");
  }
  const at = occurredAt instanceof Date ? (Number.isNaN(occurredAt.getTime()) ? undefined : occurredAt.toISOString()) : occurredAt;
  if (occurredAt !== undefined) {
    const time = instantOf(at), now = Date.now();
    if (time === null || time > now + clockSkew || time < now - eventWindow) throw new ChestError("invalid_event", 400, "occurredAt is an RFC 3339 instant of the last 72 hours");
  }
  const cause = handling.getStore();
  const body = JSON.stringify({ type, data, ...(subject === undefined ? {} : { subject }), ...(key === undefined ? {} : { key }), ...(at === undefined ? {} : { occurredAt: at }), ...(audience === undefined ? {} : { audience: audienceOf(audience) }), ...(cause === undefined ? {} : { cause }) });
  const response = await ask("events", "POST", "/events", { body, type: "application/json" });
  if (response.status === 200 || response.status === 202) {
    const answer = object(await readJson(response));
    const id = answer?.["id"], receivers = answer?.["receivers"];
    if (typeof id !== "string" || !eventChannel.id.test(id) || typeof receivers !== "number" || !Number.isSafeInteger(receivers) || receivers < 0) throw new Unavailable();
    return { id, receivers };
  }
  if (response.status < 400) {
    await response.body?.cancel();
    throw new Unavailable();
  }
  throw await refusal(response, "events");
}

// acknowledgeErasure tells the Chest the tool deleted or anonymised what it
// kept of the person of that erasure (member.erased): the owner sees it done.
// Acknowledging again is harmless. Errors: ChestError erasure_not_found
// (404, an erasure this tool was not told of), invalid_id (400),
// CapabilityNotGranted (403: the version does not receive member events),
// Unavailable.
export async function acknowledgeErasure(erasure: string): Promise<void> {
  if (typeof erasure !== "string" || !erasureIdPattern.test(erasure)) throw new ChestError("invalid_id", 400, "invalid erasure identifier");
  const response = await ask("events", "POST", `/erasures/${erasure}/done`);
  if (response.status === 204) return;
  if (response.status < 400) {
    await response.body?.cancel();
    throw new Unavailable();
  }
  throw await refusal(response, "events");
}
