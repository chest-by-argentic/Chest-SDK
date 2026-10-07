import type { IncomingMessage } from "node:http";
import { ask as chest, errorCode, json, refusal } from "./api.js";
import { CapabilityNotGranted, ChestError, MemberRequired, NotAllowed, SealedInvalid, SealedLocked, SealedLost, Unavailable } from "./errors.js";

// Sealed values, for a server tool whose chest.json declares
// "capabilities": ["sealed"]: an IBAN, a salary, a medical note, a
// confidential message. The Chest seals a value with a key of the tool that
// never leaves the Chest; the tool stores the sealed text in its own
// database, in any text column. Only the tool opens it again, through its
// Chest, on the request of a member who has the tool — and holds one of the
// roles the value was sealed for, when it was sealed for some. The Data tab,
// the agents' SQL, a builder, the owner, the backups read the sealed text
// alone, shown as "Sealed". Every open is journaled (who, how many, when;
// never a value), and every new version of the tool waits for the owner or
// an admin: its code can read sealed data.
//
//   import { seal, open, openMany, isSealed } from "@argentic/chest-sdk/sealed";
//   const iban = await seal("FR76 3000 6000 0112 3456 7890 189", { context: `employee:${id}`, roles: ["hr"] });
//   await sql`update employees set iban = ${iban} where id = ${id}`;
//   // On a request of a member (its ticket travels with it):
//   const plain = await open(request, row.iban, { context: `employee:${row.id}` });
//   const page = await openMany(request, rows.map(r => ({ sealed: r.iban, context: `employee:${r.id}` })));
//   // → string | null each: null for a value this member may not open
//
// context binds a value to where it belongs (the row it is in): a sealed
// value copied into another row does not open there. roles are among those
// chest.json declares; the Chest checks the member's role (set by the owner
// or an admin, never by the tool). Seal what nobody searches: a sealed value
// is never searchable, sortable or filterable on the server; keep in clear
// what lists and filters need. Sealing needs no member (a public form, a
// schedule seal too); opening needs one, on their request.
//
// Errors: MemberRequired (no member on the request, or their ticket
// expired: a request lasts 60 seconds), NotAllowed (the member lost the
// tool, or open() of a value sealed for roles they do not hold),
// SealedInvalid (open() of a value altered, another tool's or of another
// context), SealedLocked (the Chest was restored and waits for its owner's
// recovery code), SealedLost (the key of this tool's values is lost for
// good), CapabilityNotGranted, Unavailable, ChestError (invalid_role,
// invalid_body 400).

// What a value is sealed with: the roles that may open it (those chest.json
// declares; any member who has the tool without) and its context.
export type SealOptions = { roles?: string[]; context?: string };
// A value to seal, and a sealed value to open in its context.
export type SealItem = { value: string } & SealOptions;
export type OpenItem = { sealed: string; context?: string };

// The bounds of a Chest: one value, a context, the roles a tool declares.
// No count bounds a call: a page of values goes in one, 4 MiB at most.
const maxValue = 512 << 10, maxContext = 256, maxRoles = 16;
const rolePattern = /^[a-z][a-z0-9-]{0,47}$/u;
// A sealed value: its format, the roles it was sealed for, its sealed bytes.
const sealedPattern = /^chest:sealed:1:(?:[a-z][a-z0-9-]{0,47}(?:,[a-z][a-z0-9-]{0,47}){0,15})?:[A-Za-z0-9_-]+$/u;
const maxSealed = 1 << 20;
const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

// isSealed says text is a sealed value of a Chest (its shape only: whether
// it opens is the Chest's to say).
export function isSealed(text: unknown): text is string {
  return typeof text === "string" && text.length <= maxSealed && sealedPattern.test(text);
}

// The ticket of the member of a request, as the Chest's front sends it
// (Chest-Opener); null without one.
function ticketOf(request: IncomingMessage | Request): string | null {
  const headers = request.headers as Headers | IncomingMessage["headers"];
  const value = typeof (headers as Headers).get === "function" ? (headers as Headers).get("chest-opener") : (headers as IncomingMessage["headers"])["chest-opener"];
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
}

function checkContext(context: unknown): string {
  if (context === undefined) return "";
  if (typeof context !== "string" || bytes(context) > maxContext) throw new ChestError("invalid_body", 400, `a context is text of ${maxContext} bytes at most`);
  return context;
}

function checkItem(item: SealItem): { value: string; roles?: string[]; context?: string } {
  if (typeof item?.value !== "string" || bytes(item.value) > maxValue) throw new ChestError("invalid_body", 400, `a sealed value is text of ${maxValue >> 10} KiB at most`);
  const context = checkContext(item.context);
  if (item.roles !== undefined && (!Array.isArray(item.roles) || item.roles.length === 0 || item.roles.length > maxRoles || !item.roles.every(r => typeof r === "string" && rolePattern.test(r)) || new Set(item.roles).size !== item.roles.length)) throw new ChestError("invalid_role", 400, "roles are 1 to 16 distinct roles the tool declares");
  return { value: item.value, ...(item.roles ? { roles: [...item.roles] } : {}), ...(context ? { context } : {}) };
}

// failed turns an answer that is not a success into what the tool tests.
async function failed(response: Response): Promise<ChestError> {
  if (response.status === 401) return new MemberRequired();
  if (response.status !== 403 && response.status !== 503) return refusal(response, "sealed");
  switch (await errorCode(response)) {
    case "access_removed": return new NotAllowed();
    case "capability_not_granted": return new CapabilityNotGranted("sealed");
    case "sealed_locked": return new SealedLocked();
    case "sealed_lost": return new SealedLost();
    default: return new Unavailable();
  }
}

async function call(path: string, ticket: string | null, body: unknown): Promise<unknown> {
  const response = await chest("sealed", "POST", path, { body: JSON.stringify(body), type: "application/json", ...(ticket === null ? {} : { headers: { "Chest-Opener": ticket } }) });
  if (response.status === 200) return json(response);
  if (response.status < 400) {
    await response.body?.cancel();
    throw new Unavailable();
  }
  throw await failed(response);
}

// sealMany seals values, each with its options, in one call: their sealed
// texts, in the order given.
export async function sealMany(items: SealItem[]): Promise<string[]> {
  const checked = items.map(checkItem);
  const answer = await call("/sealed/seal", null, { items: checked }) as { sealed?: unknown };
  if (!Array.isArray(answer?.sealed) || answer.sealed.length !== checked.length || !answer.sealed.every(isSealed)) throw new Unavailable();
  return answer.sealed;
}

// seal seals one value: its sealed text, to store.
export async function seal(value: string, options: SealOptions = {}): Promise<string> {
  return (await sealMany([{ value, ...options }]))[0]!;
}

// openMany opens values for the member of request, in one call: each
// value's text, or null for one this member may not open (sealed for roles
// they do not hold), or that is not a value of this tool in that context.
export async function openMany(request: IncomingMessage | Request, items: OpenItem[]): Promise<(string | null)[]> {
  const ticket = ticketOf(request);
  if (ticket === null) throw new MemberRequired();
  const checked = items.map(item => {
    if (typeof item?.sealed !== "string" || item.sealed.length > maxSealed) throw new ChestError("invalid_body", 400, "a sealed value is the text seal returned");
    const context = checkContext(item.context);
    return { sealed: item.sealed, ...(context ? { context } : {}) };
  });
  const answer = await call("/sealed/open", ticket, { items: checked }) as { values?: unknown };
  const values = answer?.values;
  if (!Array.isArray(values) || values.length !== checked.length) throw new Unavailable();
  return values.map(v => {
    const item = v as { value?: unknown; refused?: unknown } | null;
    if (typeof item?.value === "string") return item.value;
    if (item?.refused === "role" || item?.refused === "invalid") return null;
    throw new Unavailable();
  });
}

// open opens one value for the member of request: its text. A value sealed
// for roles the member does not hold is NotAllowed; one altered, of another
// tool or another context, SealedInvalid.
export async function open(request: IncomingMessage | Request, sealed: string, options: { context?: string } = {}): Promise<string> {
  const ticket = ticketOf(request);
  if (ticket === null) throw new MemberRequired();
  const context = checkContext(options.context);
  if (typeof sealed !== "string" || sealed.length > maxSealed) throw new ChestError("invalid_body", 400, "a sealed value is the text seal returned");
  const answer = await call("/sealed/open", ticket, { items: [{ sealed, ...(context ? { context } : {}) }] }) as { values?: unknown };
  const item = (Array.isArray(answer?.values) && answer.values.length === 1 ? answer.values[0] : null) as { value?: unknown; refused?: unknown } | null;
  if (typeof item?.value === "string") return item.value;
  if (item?.refused === "role") throw new NotAllowed();
  if (item?.refused === "invalid") throw new SealedInvalid();
  throw new Unavailable();
}
