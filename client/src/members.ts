import { ask, json, refusal } from "./api.js";
import { ChestError, Unavailable } from "./errors.js";
import { groupIdPattern, languagePattern, memberIdPattern, timeZonePattern, type Member } from "./member.js";

// Who has the tool, for a server tool whose chest.json declares
// "capabilities": ["members"] (and "members.email" for their addresses):
// exactly the members who have access to it at the time of the call — by a
// grant, a group, open to all, or because they run it. list and get see
// only them; lookup also names those the tool had who no longer have it
// (FormerMember), so that what they did keeps its author.
//
//   import * as members from "@argentic/chest-sdk/members";
//   const { members: page, next } = await members.list({ q: "cam" });
//   const one = await members.get("mbr_…");            // null: no such member here
//   const { members: found, former, unknown } = await members.lookup(ids);
//   const all = await members.groups.list();          // groups that give the tool
//
// Store member identifiers in your data, never names or addresses: resolve
// them when rendering, with lookup. Errors: CapabilityNotGranted (403),
// RateLimited (429, 600 calls a minute), Unavailable (503, or the Chest not
// reached), ChestError otherwise (invalid_id, invalid_query 400).

// A page of the list, and the cursor of the next one (null after the last).
export type MemberPage = { members: Member[]; next: string | null };
// Someone the tool had who no longer has it: "no_access" with their name, a
// member of the Chest who lost access to the tool — render “Léa Dubois (no
// access)” —; "former" with the name they had, a member who left the Chest —
// “Léa Dubois (former member)” —; or "erased" without any once the owner had
// their data erased — “Former member”.
export type FormerMember = { id: string; name: string | null; status: "no_access" | "former" | "erased" };
// What a lookup found: members who have the tool, those it had who no
// longer have it, and identifiers the tool does not know — never had, or
// forgotten.
export type Lookup = { members: Member[]; former: FormerMember[]; unknown: string[] };
// A group that gives the tool, with the identifiers of its members.
export type Group = { id: string; name: string; members: string[] };

const maxLimit = 500;
const lookupBatch = 200;
const cacheTime = 60_000;
const cacheSize = 5000;

function checkId(id: unknown): string {
  if (typeof id !== "string" || !memberIdPattern.test(id)) throw new ChestError("invalid_id", 400, "invalid member identifier");
  return id;
}

const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;

// shown reads a member as the Chest answers it; anything else is not the
// Chest's answer.
function shown(value: unknown): Member {
  const m = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!m || typeof m["id"] !== "string" || !memberIdPattern.test(m["id"]) || !text(m["first_name"], 256) || !text(m["last_name"], 256) || !text(m["name"], 520) || !(m["photo"] === null || text(m["photo"], 200)) || !(m["role"] === null || text(m["role"], 48)) || typeof m["admin"] !== "boolean" || typeof m["builder"] !== "boolean" || !Array.isArray(m["groups"]) || m["groups"].length > 16 || !m["groups"].every(g => typeof g === "string" && groupIdPattern.test(g)) || typeof m["language"] !== "string" || !languagePattern.test(m["language"]) || typeof m["time_zone"] !== "string" || !timeZonePattern.test(m["time_zone"]) || !(m["email"] === undefined || text(m["email"], 254))) throw new Unavailable();
  return { id: m["id"], firstName: m["first_name"], lastName: m["last_name"], name: m["name"], photo: m["photo"], role: m["role"], isAdmin: m["admin"], isBuilder: m["builder"], groups: [...m["groups"]] as string[], language: m["language"], timeZone: m["time_zone"], ...(m["email"] === undefined ? {} : { email: m["email"] }) };
}

// list says the members who have the tool, by name then identifier, limit
// at a time (100 by default, 500 at most), after the cursor of the previous
// page. q finds the start of a first name, a last name or a name (and of an
// address with members.email), whatever its case and accents; role and group
// keep the members of that role, or of that group.
export async function list(options: { after?: string; limit?: number; q?: string; role?: string; group?: string } = {}): Promise<MemberPage> {
  const query = new URLSearchParams();
  if (options.after !== undefined) query.set("after", options.after);
  if (options.limit !== undefined) {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > maxLimit) throw new ChestError("invalid_query", 400, "limit is 1 to 500");
    query.set("limit", String(options.limit));
  }
  if (options.q !== undefined && options.q !== "") query.set("q", options.q);
  if (options.role !== undefined) query.set("role", options.role);
  if (options.group !== undefined) {
    if (!groupIdPattern.test(options.group)) throw new ChestError("invalid_query", 400, "invalid group identifier");
    query.set("group", options.group);
  }
  const response = await ask("members", "GET", "/members" + (query.size ? "?" + query.toString() : ""));
  if (response.status !== 200) throw await refusal(response, "members");
  const page = (await json(response)) as { members?: unknown; next?: unknown } | null;
  if (!page || !Array.isArray(page.members) || page.members.length > maxLimit || !(page.next === null || text(page.next, 1024))) throw new Unavailable();
  return { members: page.members.map(shown), next: page.next };
}

// get is the member of that identifier, or null when they do not have the
// tool: never a member, a former one, or one without access (lookup names
// the last two).
export async function get(id: string): Promise<Member | null> {
  const response = await ask("members", "GET", "/members/" + checkId(id));
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (response.status !== 200) throw await refusal(response, "members");
  return shown(await json(response));
}

// What lookup keeps in this process: each identifier's answer for a minute,
// 5000 of them at most, the oldest forgotten first — and nothing once an
// event of the members' lifecycle comes (events.handle).
type Known = { at: number } & ({ member: Member } | { former: FormerMember } | { unknown: true });
const known = new Map<string, Known>();

// forget empties what lookup keeps: the next lookup asks the Chest again.
export function forget(): void {
  known.clear();
}

function keep(id: string, answer: Omit<Known, "at">): void {
  known.delete(id);
  known.set(id, { ...answer, at: Date.now() } as Known);
  while (known.size > cacheSize) known.delete(known.keys().next().value as string);
}

// lookup resolves identifiers, each once, in the order given: the members
// who have the tool, those it had who no longer have it, and the identifiers
// it does not know. Any number of them: the SDK asks 200 at a time, and keeps
// each answer a minute.
export async function lookup(ids: Iterable<string>): Promise<Lookup> {
  const wanted = [...new Set([...ids].map(checkId))];
  const now = Date.now();
  const missing = wanted.filter(id => {
    const k = known.get(id);
    return !k || now - k.at >= cacheTime;
  });
  for (let i = 0; i < missing.length; i += lookupBatch) {
    const batch = missing.slice(i, i + lookupBatch);
    const response = await ask("members", "POST", "/members/lookup", { body: JSON.stringify({ ids: batch }), type: "application/json" });
    if (response.status !== 200) throw await refusal(response, "members");
    const answer = (await json(response)) as { members?: unknown; former?: unknown; unknown?: unknown } | null;
    if (!answer || !Array.isArray(answer.members) || !Array.isArray(answer.former) || !Array.isArray(answer.unknown)) throw new Unavailable();
    const told = new Set<string>();
    for (const m of answer.members.map(shown)) {
      keep(m.id, { member: m });
      told.add(m.id);
    }
    for (const value of answer.former) {
      const f = value as { id?: unknown; name?: unknown; status?: unknown } | null;
      if (!f || typeof f.id !== "string" || !memberIdPattern.test(f.id) || !(f.status === "former" ? f.name === undefined || text(f.name, 520) : f.status === "no_access" ? text(f.name, 520) : f.status === "erased" && f.name === undefined)) throw new Unavailable();
      keep(f.id, { former: { id: f.id, name: (f.name as string | undefined) ?? null, status: f.status as FormerMember["status"] } });
      told.add(f.id);
    }
    for (const id of answer.unknown) {
      if (typeof id !== "string" || !memberIdPattern.test(id)) throw new Unavailable();
      keep(id, { unknown: true });
      told.add(id);
    }
    if (batch.some(id => !told.has(id))) throw new Unavailable();
  }
  const result: Lookup = { members: [], former: [], unknown: [] };
  for (const id of wanted) {
    const k = known.get(id);
    if (k && "member" in k) result.members.push(k.member);
    else if (k && "former" in k) result.former.push(k.former);
    else result.unknown.push(id);
  }
  return result;
}

// groups are the groups of the Chest that give the tool, each with the
// identifiers of its members; nothing of the others.
export const groups = {
  async list(): Promise<Group[]> {
    const response = await ask("members", "GET", "/groups");
    if (response.status !== 200) throw await refusal(response, "members");
    const answer = (await json(response)) as { groups?: unknown } | null;
    if (!answer || !Array.isArray(answer.groups) || answer.groups.length > 16) throw new Unavailable();
    return answer.groups.map(value => {
      const g = value as { id?: unknown; name?: unknown; members?: unknown } | null;
      if (!g || typeof g.id !== "string" || !groupIdPattern.test(g.id) || !text(g.name, 256) || !Array.isArray(g.members) || g.members.length > 128 || !g.members.every(m => typeof m === "string" && memberIdPattern.test(m))) throw new Unavailable();
      return { id: g.id, name: g.name, members: [...g.members] as string[] };
    });
  },
};
