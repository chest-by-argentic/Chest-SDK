import { ask as chest, json, refusal } from "./api.js";
import { ChestError, Unavailable } from "./errors.js";
import { memberIdPattern } from "./member.js";

// Counters and notifications inside the Chest, for a server tool whose
// chest.json declares "capabilities": ["notifications"]: a badge is a count
// shown on the tool's tile for one member; a notification is an item in a
// member's inbox that opens a page of the tool. Only members who have access
// to the tool receive them; nothing leaves the Chest (no email, no push).
//
//   import * as notifications from "@argentic/chest-sdk/notifications";
//   const { delivered, skipped } = await notifications.notify(ids, { title: "New task", path: "/chest/tasks/42", key: "task:42" });
//   await notifications.withdraw("task:42");                // the task is done: its items go
//   const shown = await notifications.badge.set("mbr_…", 3); // false: no access
//   await notifications.badge.setMany([{ memberId: "mbr_…", count: 0 }]);
//
// Text is plain: the Chest removes control characters, interprets neither
// Markdown nor HTML, keeps line breaks in body. A member who muted the tool
// counts as delivered: the tool never learns it. Errors: CapabilityNotGranted
// (403), QuotaExceeded (429: 1,000 recipients an hour, 100 items per member a
// day, 600 badge writes a minute), Unavailable (503, or the Chest not
// reached), ChestError otherwise (invalid_id, invalid_title, invalid_text,
// invalid_path, invalid_key, invalid_count, invalid_body 400).

// What a notification says: title (1 to 80 characters), body (280 at most),
// path (the page of the tool it opens, under /chest; /chest when not said)
// and key (a name of the tool's: an item of the same key for the same member
// is replaced, and withdraw removes it).
export type Notice = { title: string; body?: string; path?: string; key?: string };
// Who got it and who not, each identifier once in the order given: skipped
// are identifiers the Chest does not know and members without access.
export type Delivery = { delivered: string[]; skipped: string[] };
// A badge to set: a member and their count, 0 to clear it.
export type BadgeCount = { memberId: string; count: number };
// The members whose badge was set, and those skipped (no access), in the
// order given.
export type BadgeWrite = { set: string[]; skipped: string[] };

// The bounds of a Chest.
const maxMembers = 500, maxTitle = 80, maxBody = 280, maxPath = 512, maxCount = 9999;
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
// checkIds reads 1 to 500 member identifiers, as given.
function checkIds(ids: Iterable<string>): string[] {
  const all = [...ids];
  if (all.length < 1 || all.length > maxMembers) throw new ChestError("invalid_body", 400, "1 to 500 member identifiers");
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

// notify puts one item in the inbox of each member who has the tool, among
// 1 to 500 identifiers (each counted once). A link to path, on the tool's
// team host, opens it. With a key, the member's item of that key is replaced:
// new text, new time, first and unread again.
export async function notify(memberIds: Iterable<string>, notice: Notice): Promise<Delivery> {
  const members = checkIds(memberIds);
  const { title, body, path, key } = notice;
  if (typeof title !== "string" || length(title) < 1 || length(title) > maxTitle || title.replace(removed, "").trim() === "") throw new ChestError("invalid_title", 400, "a title is 1 to 80 characters");
  if (body !== undefined && (typeof body !== "string" || length(body) > maxBody)) throw new ChestError("invalid_text", 400, "a body is 280 characters at most");
  const command = { members, title, ...(body ? { body } : {}), ...(path !== undefined ? { path: checkPath(path) } : {}), ...(key !== undefined ? { key: checkKey(key) } : {}) };
  const response = await ask("POST", "/notifications", command);
  await expect(response, 200);
  const [delivered, skipped] = partition(await json(response), "delivered", "skipped", members);
  return { delivered, skipped };
}

// withdraw removes the items of that key, from every member or from those
// named (1 to 500): the thing they were about is done. It never says what
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
  // setMany sets 1 to 500 badges, a member at most once.
  async setMany(counts: Iterable<BadgeCount>): Promise<BadgeWrite> {
    const all = [...counts];
    if (all.length < 1 || all.length > maxMembers) throw new ChestError("invalid_body", 400, "1 to 500 badges");
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
