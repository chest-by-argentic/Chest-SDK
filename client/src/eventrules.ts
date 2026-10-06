import { groupIdPattern, memberIdPattern } from "./member.js";

// The rules of events between tools, as the Chest applies them
// (chest/toolevents): what a type, an identifier, an instant, an audience
// and a declared field are. events reads a delivery and checks an emit with
// them before sending it; testing's fake Chest refuses what the Chest
// refuses with them. Not a published module.

// A type: two to four dotted segments of lowercase letters, digits and
// dashes, each starting with a letter, 64 characters at most; member.* and
// access.* are the Chest's own (the members' lifecycle).
const typePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*){1,3}$/u;
export const isToolEventType = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 64 && typePattern.test(value) && !value.startsWith("member.") && !value.startsWith("access.");

// An identifier of the publisher's own: the "id" kind of a field, an
// event's subject and its idempotency key.
export const itemIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
// The name of a tool, as an event's source.
export const toolNamePattern = /^[a-z][a-z0-9-]{0,47}$/u;
// A role of a tool's own (chest.json "roles"), as an audience or a
// broadcast names it.
export const rolePattern = /^[a-z][a-z0-9-]{0,47}$/u;
// A field of an event's data: a camelCase name.
export const fieldNamePattern = /^[a-z][A-Za-z0-9]{0,39}$/u;

// The largest data of one event, in bytes of its JSON (UTF-8).
export const maxData = 16 << 10;
// How far back an event's occurredAt may go — the Chest's 72 hours of
// retries — and how far ahead the clocks of the Chest and of the container
// may differ, in milliseconds.
export const eventWindow = 72 * 3600_000;
export const clockSkew = 5000;

const daysIn = (year: number, month: number): number => month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
const instantPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/u;
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/u;

// instantOf is the time of an RFC 3339 instant (a date, a time to the
// second or finer, Z or an offset) in milliseconds, or null for anything
// else — a day or an hour that does not exist included.
export function instantOf(value: unknown): number | null {
  const parts = typeof value === "string" ? instantPattern.exec(value) : null;
  if (!parts) return null;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = parts.slice(1).map(v => Number(v ?? "0")) as [number, number, number, number, number, number, number, number];
  if (month < 1 || month > 12 || day < 1 || day > daysIn(year, month) || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return null;
  return Date.parse(value as string);
}

// isDate says a value is a day that exists, YYYY-MM-DD.
export function isDate(value: unknown): boolean {
  const parts = typeof value === "string" ? datePattern.exec(value) : null;
  if (!parts) return false;
  const [year, month, day] = parts.slice(1).map(Number) as [number, number, number];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysIn(year, month);
}

// Text: no control character (C0, C1) but line feeds and tabs, no format
// character (Cf: U+200B, U+202E…) and no unpaired surrogate; no length of
// its own (the data's 16 KiB bound it).
const isText = (value: unknown): boolean => typeof value === "string" && !/[^\P{Cc}\n\t]|[\p{Cf}\p{Cs}]/u.test(value);

// The kinds of a declared field, and what a value of each is. A member is
// one the publisher has or had (known).
export type FieldKind = "id" | "text" | "number" | "boolean" | "time" | "date" | "member" | "members";
const kinds: Record<FieldKind, (value: unknown, known: (id: string) => boolean) => boolean> = {
  id: value => typeof value === "string" && itemIdPattern.test(value),
  text: isText,
  number: value => typeof value === "number" && Number.isFinite(value),
  boolean: value => typeof value === "boolean",
  time: value => instantOf(value) !== null,
  date: isDate,
  member: (value, known) => typeof value === "string" && memberIdPattern.test(value) && known(value),
  // A list, empty or not, of distinct members.
  members: (value, known) => Array.isArray(value) && value.every(v => typeof v === "string" && memberIdPattern.test(v) && known(v)) && new Set(value).size === value.length,
};

// fieldOf reads a field's declaration in "emits" ("number", "text?"): its
// kind and whether it may be left out; null for one the Chest refuses.
export function fieldOf(declared: unknown): { kind: FieldKind; optional: boolean } | null {
  if (typeof declared !== "string") return null;
  const optional = declared.endsWith("?"), kind = optional ? declared.slice(0, -1) : declared;
  return Object.hasOwn(kinds, kind) ? { kind: kind as FieldKind, optional } : null;
}

// isDeclaredData says data is what its type declares: an object with every
// required field, no field not declared, each value of its kind — null is
// a field left out. declared
// maps each field to its kind ("text?"), as "emits" names them; known says
// a member is one the publisher has or had. Its size (maxData) is checked
// apart.
export function isDeclaredData(data: unknown, declared: Record<string, string>, known: (id: string) => boolean): boolean {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return false;
  const given = data as Record<string, unknown>;
  for (const name of Object.keys(given)) if (!Object.hasOwn(declared, name)) return false;
  return Object.entries(declared).every(([name, spec]) => {
    const field = fieldOf(spec);
    if (!field) return false;
    if (!Object.hasOwn(given, name) || given[name] === null) return field.optional;
    return kinds[field.kind](given[name], known);
  });
}

// An event's audience as the publisher names it: members, groups and roles
// of the publisher, any of whom may see the item.
export type Audience = { members?: string[]; groups?: string[]; roles?: string[] };
const audienceLists: Record<keyof Audience, RegExp> = { members: memberIdPattern, groups: groupIdPattern, roles: rolePattern };

// isAudience says a value is an audience the Chest takes: an object of
// members, groups and roles only, each a list of distinct identifiers of
// its grammar, one list at least not empty.
export function isAudience(value: unknown): value is Audience {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const lists = Object.entries(value as Record<string, unknown>);
  return lists.some(([, list]) => Array.isArray(list) && list.length > 0) && lists.every(([name, list]) =>
    Object.hasOwn(audienceLists, name) && Array.isArray(list) && list.every(v => typeof v === "string" && audienceLists[name as keyof Audience].test(v)) && new Set(list).size === list.length);
}
