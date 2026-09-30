import type { IncomingMessage } from "node:http";
import { ask, refusal } from "./api.js";
import { ChestError, Unavailable } from "./errors.js";
import { memberIdPattern } from "./member.js";
import { forget } from "./members.js";
import { delivery, eventChannel, instant, json, memorySeen, object, type Seen } from "./signed.js";

// What the Chest tells a server tool of its members' lifecycle, for a tool
// whose chest.json declares "capabilities": ["members"] and "receives":
// ["member.*"]. The Chest posts each event to the tool's POST /chest-events,
// through its launcher only (never from the Internet), signed for this tool:
//
//   // app/chest-events/route.ts (Next.js): outside /chest, never behind a session
//   import * as events from "@argentic/chest-sdk/events";
//   export async function POST(request: Request) {
//     return new Response(null, { status: await events.handle(request, {
//       "member.erased": async e => { await anonymise(e.data.id); await events.acknowledgeErasure(e.data.erasure); },
//       "access.revoked": e => unassign(e.data.id),
//     }, { seen }) });
//   }
//
// Delivery is at least once, in no guaranteed order: the same event may come
// again, always with the same id — handle() drops what the store of seen ids
// already holds. An event the tool does not answer with a success is
// delivered again, after a growing delay, for 72 hours; after that the tool
// is out of sync and reconciles by listing its members (members.list) at its
// next start. Every event also empties what members.lookup keeps.

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
// An event, told apart by its type.
export type ChestEvent = MemberUpdated | AccessRevoked | MemberRemoved | MemberErased;
export type ChestEventType = ChestEvent["type"];

// What handle() calls for each type; a type left out is accepted and ignored.
export type Handlers = { [K in ChestEventType]?: (event: Extract<ChestEvent, { type: K }>) => void | Promise<void> };

// Where handle() remembers the ids of the events already handled (Seen), and
// memorySeen, which keeps them in this process: shared with schedules.
export { memorySeen, type Seen } from "./signed.js";

// The grammar of an erasure's identifier, as the Chest mints it.
export const erasureIdPattern = /^era_[a-z2-7]{26}$/u;
const changes: readonly string[] = ["name", "photo", "role", "groups", "email", "language", "timeZone"];

// envelope reads a signed delivery: the envelope when the signature, the tool,
// the time and the digest of the body hold; known says its type is one this
// SDK reads.
async function envelope(request: IncomingMessage | Request): Promise<{ event: ChestEvent; known: true } | { event: { id: string }; known: false } | null> {
  const signed = await delivery(request, eventChannel);
  if (!signed) return null;
  const { id: jti, body } = signed;
  const e = object(json(body.toString("utf8")));
  if (!e || Object.keys(e).length !== 4 || e["id"] !== jti || typeof e["type"] !== "string" || !instant(e["occurredAt"])) return null;
  const data = object(e["data"]);
  if (!data || typeof data["id"] !== "string" || !memberIdPattern.test(data["id"])) return null;
  const keys = Object.keys(data).sort().join(",");
  const base = { id: jti, occurredAt: e["occurredAt"] as string };
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
  return { known: false, event: { id: jti } };
}

// verify returns the event a delivery carries, or null when it is not one
// the Chest made for this tool — no or another signature, for another tool,
// expired, a body that is not the one signed, not a POST — or when it is of a
// type this SDK does not know. It reads the body (64 KiB at most): call it
// before anything else reads it. It never throws for what a request carries.
export async function verify(request: IncomingMessage | Request): Promise<ChestEvent | null> {
  const read = await envelope(request);
  return read?.known ? read.event : null;
}

const remembered = memorySeen();

// handle verifies one delivery and hands the event to its handler, once:
// the status to answer the Chest. 401 for a delivery that is not the
// Chest's; 204 for an event handled, one already seen (seen.has), a type
// without a handler or one this SDK does not know. A handler that throws
// leaves the event unseen and handle throws: answer 500, the Chest delivers
// it again. seen is the store of the ids handled (memorySeen by default,
// lost at a restart: give a durable one).
export async function handle(request: IncomingMessage | Request, handlers: Handlers, options: { seen?: Seen } = {}): Promise<number> {
  const read = await envelope(request);
  if (!read) return 401;
  if (!read.known) return 204;
  const seen = options.seen ?? remembered;
  const event = read.event;
  if (await seen.has(event.id)) return 204;
  // A member changed or left: what lookup kept of them is stale.
  forget();
  const handler = handlers[event.type] as ((e: ChestEvent) => void | Promise<void>) | undefined;
  if (handler) await handler(event);
  await seen.add(event.id);
  return 204;
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
