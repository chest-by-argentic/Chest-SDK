import { ChestError } from "./errors.js";
import { languagePattern, timeZonePattern } from "./member.js";

// The Chest the tool runs in, the same for every member and every request:
// the organization it is of, its time zone, its language and its currency —
// and where this tool is reached. The Chest sets them in the tool's
// environment at each start (CHEST_ORGANIZATION, CHEST_TIME_ZONE,
// CHEST_LANGUAGE, CHEST_CURRENCY, CHEST_TEAM_URL, CHEST_PUBLIC_URL) and
// starts the tool again, when it is awake, as soon as one changes, so they
// are there outside any request too: in a scheduled job, at start-up, in a
// migration script. The Chest also sets its time zone
// as the zone of the tool's database sessions: there, current_date and
// now()::date are the Chest's day too.
//
// - organization.name is the organization's name as its owner wrote it
//   ("Acme SAS"), plain text of 2 to 80 characters: for a header, a document,
//   an email.
// - timeZone is an IANA zone ("Europe/Paris"; "UTC" until the owner sets
//   one): the day of "due today", the hour of a reminder.
// - language is the Chest's own language, a primary tag ("en", "fr"): the
//   language of what the tool writes for no one in particular (a public page
//   before the visitor chooses, an export). A member's is member.language.
// - currency is the ISO 4217 code of the Chest's currency ("EUR" until the
//   owner sets one): the amounts the tool writes — a quote, a price.
// - tool.teamUrl is the origin of the tool's team host, where its members
//   open /chest; tool.publicUrl the origin of its public part — the
//   company's own domain when the owner connected one —, null for a tool
//   without a public part. Origins, without a path: a link in an email is
//   new URL("/chest/tasks/42", chest.tool.teamUrl). Store paths, never
//   these origins: they change with a custom domain.
// - today() is the date ("YYYY-MM-DD") in the Chest's zone, now or at the
//   instant given.
//
// Reading one outside a Chest (no fakeChest in a test, a development server
// without the variables) throws a ChestError "not_in_chest": a wrong zone
// read silently is the bug this module is for.
export type Chest = {
  readonly organization: { readonly name: string };
  readonly timeZone: string;
  readonly language: string;
  readonly currency: string;
  readonly tool: { readonly teamUrl: string; readonly publicUrl: string | null };
  today(at?: Date | number): string;
};

// The shapes the Chest gives: the organization's (2 to 80 characters,
// counted as code points, without control characters), a zone's
// (timeZonePattern, and one this runtime knows), a language's, a currency's,
// an origin's.
const organizationPattern = /^[^\u0000-\u001f\u007f-\u009f]{2,80}$/u;
// An ISO 4217 code; an https origin without a path, as the Chest gives them.
const currencyPattern = /^[A-Z]{3}$/u;
const originPattern = /^https:\/\/[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:[0-9]{1,5})?$/u;

function read(name: string, valid: (value: string) => boolean): string {
  const value = process.env[name];
  if (typeof value !== "string" || !valid(value)) throw new ChestError("not_in_chest", 500, `not running in a Chest: ${name} is missing or invalid`);
  return value;
}

function knownZone(zone: string): boolean {
  if (!timeZonePattern.test(zone)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const zone = (): string => read("CHEST_TIME_ZONE", knownZone);

// dateIn is the date at that instant in a zone, as YYYY-MM-DD.
function dateIn(at: Date, zone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at).map(p => [p.type, p.value]));
  return `${parts["year"]}-${parts["month"]}-${parts["day"]}`;
}

// chest reads the environment at each access: what a test's fakeChest sets
// is what it answers.
export const chest: Chest = {
  get organization() {
    return { name: read("CHEST_ORGANIZATION", value => organizationPattern.test(value)) };
  },
  get timeZone() {
    return zone();
  },
  get language() {
    return read("CHEST_LANGUAGE", value => languagePattern.test(value));
  },
  get currency() {
    return read("CHEST_CURRENCY", value => currencyPattern.test(value));
  },
  get tool() {
    const teamUrl = read("CHEST_TEAM_URL", value => originPattern.test(value));
    const publicUrl = process.env["CHEST_PUBLIC_URL"] === undefined ? null : read("CHEST_PUBLIC_URL", value => originPattern.test(value));
    return { teamUrl, publicUrl };
  },
  today(at: Date | number = Date.now()): string {
    const instant = typeof at === "number" ? new Date(at) : at;
    if (Number.isNaN(instant.getTime())) throw new RangeError("today() needs a valid date");
    return dateIn(instant, zone());
  },
};
