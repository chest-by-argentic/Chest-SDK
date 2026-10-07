import { ask as chest, json, refusal } from "./api.js";
import { ChestError, Unavailable } from "./errors.js";
import { rolePattern } from "./eventrules.js";
import { groupIdPattern, languagePattern, memberIdPattern } from "./member.js";

// Counters and notifications inside the Chest, for a server tool whose
// chest.json declares "capabilities": ["notifications"]: a badge is a count
// shown on the tool's tile for one member; a notification is an item in a
// member's inbox that opens a page of the tool. Only members who have access
// to the tool receive them. The tool sends nothing else: members may get
// mails of their notifications, as each of them chooses — the Chest's
// service. A notice may say the same in other languages: each member reads
// the one of theirs (member.language), the tool's own otherwise. Nothing is
// refused for its pace: beyond ten at once to a member, then one every six
// minutes, the Chest folds a tool's notices into one grouped item of that
// member's inbox ("37 new notifications", the latest shown) — the call
// still succeeds, nothing is lost.
//
//   import * as notifications from "@argentic/chest-sdk/notifications";
//   const { delivered, skipped } = await notifications.notify(ids, { title: "New task", path: "/chest/tasks/42", key: "task:42" });
//   await notifications.broadcast({ title: "New poll", translations: { fr: { title: "Nouveau sondage" } }, path: "/chest/polls/7" }, { to: { groups: ["grp_…"] }, except: [author] });
//   await notifications.withdraw("task:42");                // the task is done: its items go
//   const shown = await notifications.badge.set("mbr_…", 3); // false: no access
//   await notifications.badge.setMany([{ memberId: "mbr_…", count: 0 }]);
//
// Text is plain: the Chest removes control characters, interprets neither
// Markdown nor HTML, keeps line breaks in body. A member who muted the tool
// counts as delivered: the tool never learns it. Badges are a state, the
// last write wins. Errors: CapabilityNotGranted (403), Unavailable (503, or
// the Chest not reached), ChestError otherwise — only a malformed or
// oversized call
// (invalid_id, invalid_role, invalid_title, invalid_text, invalid_path,
// invalid_key, invalid_language, invalid_count, invalid_body 400).

// The words of a notification in one language: title (1 to 80 characters)
// and body (280 at most).
export type Words = { title: string; body?: string };
// What a notification says: its words in the tool's own language, path (the
// page of the tool it opens, under /chest; /chest when not said), key (a
// name of the tool's: an item of the same key for the same member is
// replaced, and withdraw removes it) and translations: the same words in
// other languages, by language tag ("fr"), each member reading theirs.
export type Notice = Words & { path?: string; key?: string; translations?: Record<string, Words> };
// Whom a broadcast reaches: every member who has the tool, or with to those
// in any of its groups or holding any of its roles — a group the tool does
// not see, or a role it does not declare, reaches no one —, but those of
// except (the author, those who already answered).
export type Audience = { to?: { groups?: string[]; roles?: string[] }; except?: Iterable<string> };
// Who got it and who not, each identifier once in the order given: skipped
// are identifiers the Chest does not know and members without access.
export type Delivery = { delivered: string[]; skipped: string[] };
// A badge to set: a member and their count, 0 to clear it.
export type BadgeCount = { memberId: string; count: number };
// The members whose badge was set, and those skipped (no access), in the
// order given.
export type BadgeWrite = { set: string[]; skipped: string[] };

// The bounds of a Chest on a call's texts and counts, and the roles a tool
// declares. No count bounds the members a call names: the Chest takes as
// many as its team holds, and refuses a body beyond (invalid_body).
const maxTitle = 80, maxBody = 280, maxPath = 512, maxCount = 9999, toolRoles = 16;
const keyPattern = /^[a-z0-9._:-]{1,64}$/u;
// What the Chest removes from a title before keeping it: control characters
// and the characters that reorder text.
const removed = /[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

const ask = (method: string, path: string, value: unknown) => chest("notifications", method, path, { body: JSON.stringify(value), type: "application/json" });
// expect lets through the one answer expected; a refusal is what the Chest
// says, any other success is not the Chest's.
async function expect(response: Response, status: number): Promise<void> {
  if (response.status === status) return;
  if (response.status < 400) {
    await response.body?.cancel();
    throw new Unavailable();
  }
  throw await refusal(response, "notifications");
}
const length = (s: string): number => [...s].length;

function checkId(id: unknown): string {
  if (typeof id !== "string" || !memberIdPattern.test(id)) throw new ChestError("invalid_id", 400, "invalid member identifier");
  return id;
}
// checkIds reads member identifiers, one at least, as given.
function checkIds(ids: Iterable<string>): string[] {
  const all = [...ids];
  if (all.length < 1) throw new ChestError("invalid_body", 400, "one member identifier at least");
  return all.map(checkId);
}
function checkKey(key: unknown): string {
  if (typeof key !== "string" || !keyPattern.test(key)) throw new ChestError("invalid_key", 400, "a key is 1 to 64 of a-z 0-9 . _ : -");
  return key;
}
function checkCount(count: unknown): number {
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > maxCount) throw new ChestError("invalid_count", 400, "a count is 0 to 9999");
  return count;
}
// checkPath accepts /chest, or /chest followed by '/', '?' or '#': printable
// ASCII but '\', 512 bytes at most, never '//', no '.' or '..' segment
// (written %2e either).
function checkPath(path: unknown): string {
  if (typeof path !== "string" || path.length > maxPath || !/^\/chest([/?#][\x21-\x5b\x5d-\x7e]*)?$/u.test(path) || path.includes("//") || path.split(/[?#]/u)[0]!.split("/").some(s => /^(\.|%2e){1,2}$/iu.test(s))) throw new ChestError("invalid_path", 400, "a path is /chest or under it");
  return path;
}

// partition checks an answer that splits the identifiers asked, each once,
// in their order, between two lists of it; anything else is not the Chest's.
function partition(answer: unknown, first: string, second: string, asked: string[]): [string[], string[]] {
  const a = answer !== null && typeof answer === "object" && !Array.isArray(answer) ? answer as Record<string, unknown> : null;
  const lists = [a?.[first], a?.[second]];
  if (!lists.every(l => Array.isArray(l) && l.every(id => typeof id === "string"))) throw new Unavailable();
  const [one, two] = lists as [string[], string[]];
  const wanted = [...new Set(asked)];
  const inOrder = (l: string[]) => l.every((id, i) => wanted.indexOf(id) > (i === 0 ? -1 : wanted.indexOf(l[i - 1]!)));
  if (one.length + two.length !== wanted.length || !inOrder(one) || !inOrder(two) || one.some(id => two.includes(id))) throw new Unavailable();
  return [[...one], [...two]];
}

// checkWords reads a title and a body as the Chest bounds them.
function checkWords(words: unknown): Words {
  const { title, body } = (words ?? {}) as Partial<Words>;
  if (typeof title !== "string" || length(title) < 1 || length(title) > maxTitle || title.replace(removed, "").trim() === "") throw new ChestError("invalid_title", 400, "a title is 1 to 80 characters");
  if (body !== undefined && (typeof body !== "string" || length(body) > maxBody)) throw new ChestError("invalid_text", 400, "a body is 280 characters at most");
  return { title, ...(body ? { body } : {}) };
}

// command is a notice as the Chest reads it.
function command(notice: Notice): Record<string, unknown> {
  const { path, key, translations } = notice;
  const other: Record<string, Words> = {};
  for (const [language, words] of Object.entries(translations ?? {})) {
    if (!languagePattern.test(language)) throw new ChestError("invalid_language", 400, "a language is a tag such as fr");
    other[language] = checkWords(words);
  }
  return { ...checkWords(notice), ...(path !== undefined ? { path: checkPath(path) } : {}), ...(key !== undefined ? { key: checkKey(key) } : {}), ...(translations !== undefined ? { translations: other } : {}) };
}

// notify puts one item in the inbox of each member who has the tool, among
// the identifiers given (each counted once), in their language. A link to
// path, on the tool's team host, opens it. With a key, the member's item of
// that key is replaced: new text, new time, first and unread again.
export async function notify(memberIds: Iterable<string>, notice: Notice): Promise<Delivery> {
  const members = checkIds(memberIds);
  const response = await ask("POST", "/notifications", { members, ...command(notice) });
  await expect(response, 200);
  const [delivered, skipped] = partition(await json(response), "delivered", "skipped", members);
  return { delivered, skipped };
}

// broadcast puts one item, in their language, in the inbox of every member
// who has the tool now — or of those the audience names —, the Chest
// resolving who they are: the tool needs not see its members. It never says
// how many received it. Each recipient counts in the quotas, all or none.
export async function broadcast(notice: Notice, audience: Audience = {}): Promise<void> {
  const { to } = audience;
  let target: { groups?: string[]; roles?: string[] } | undefined;
  if (to !== undefined) {
    const groups = to.groups === undefined ? undefined : [...to.groups], roles = to.roles === undefined ? undefined : [...to.roles];
    if (!groups?.length && !roles?.length) throw new ChestError("invalid_body", 400, "to names groups or roles: leave it out for everyone");
    if ((roles?.length ?? 0) > toolRoles) throw new ChestError("invalid_body", 400, "16 roles at most: those the tool declares");
    if (groups && !groups.every(g => typeof g === "string" && groupIdPattern.test(g))) throw new ChestError("invalid_id", 400, "invalid group identifier");
    if (roles && !roles.every(r => typeof r === "string" && rolePattern.test(r))) throw new ChestError("invalid_role", 400, "invalid role");
    target = { ...(groups?.length ? { groups } : {}), ...(roles?.length ? { roles } : {}) };
  }
  const except = audience.except === undefined ? undefined : [...audience.except];
  except?.forEach(checkId);
  const response = await ask("POST", "/notifications/broadcast", { ...command(notice), ...(target ? { to: target } : {}), ...(except?.length ? { except } : {}) });
  await expect(response, 204);
}

// withdraw removes the items of that key, from every member or from those
// named: the thing they were about is done. It never says what
// existed.
export async function withdraw(key: string, memberIds?: Iterable<string>): Promise<void> {
  const command = { key: checkKey(key), ...(memberIds !== undefined ? { members: checkIds(memberIds) } : {}) };
  const response = await ask("POST", "/notifications/withdraw", command);
  await expect(response, 204);
}

// badge sets the count shown on the tool's tile for a member (0 to 9,999; 0
// clears it): a state, not an event, so setting it again changes nothing.
export const badge = {
  // set is true once the member's badge is set, false when they do not have
  // the tool.
  async set(memberId: string, count: number): Promise<boolean> {
    checkId(memberId);
    const response = await ask("PUT", "/badges/" + memberId, { count: checkCount(count) });
    await expect(response, 200);
    return partition(await json(response), "set", "skipped", [memberId])[0].length === 1;
  },
  // setMany sets badges, one at least, a member at most once.
  async setMany(counts: Iterable<BadgeCount>): Promise<BadgeWrite> {
    const all = [...counts];
    if (all.length < 1) throw new ChestError("invalid_body", 400, "one badge at least");
    const badges = all.map(b => {
      if (b === null || typeof b !== "object") throw new ChestError("invalid_body", 400, "a badge is {memberId, count}");
      return { member: checkId(b.memberId), count: checkCount(b.count) };
    });
    if (new Set(badges.map(b => b.member)).size !== badges.length) throw new ChestError("invalid_body", 400, "a member at most once");
    const response = await ask("PUT", "/badges", { badges });
    await expect(response, 200);
    const [set, skipped] = partition(await json(response), "set", "skipped", badges.map(b => b.member));
    return { set, skipped };
  },
};
