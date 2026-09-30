import type { IncomingMessage } from "node:http";
import { headerValue, signedClaims } from "./signed.js";

// A member of the Chest, as the tool sees them: on a request of its team host
// (member), and in its members (members.ts).
//
// - id is the member's identifier in this Chest, "mbr_" and 26 characters:
//   the same in every tool of the Chest, never reused, never derived from an
//   address or an account. Store it; resolve names when rendering.
// - name is "First Last", or the local part of the address when the member
//   set no name.
// - photo is the address of their picture on the tool's team host
//   (/_chest/members/{id}/photo?v=<rev>), role one of the roles chest.json
//   declares: null when there is none.
// - isBuilder says they build this tool; groups are the groups that give them
//   this tool ("grp_…").
// - language is the language the Chest speaks to this member (their own,
//   else the Chest's default): a BCP 47 primary tag the product speaks
//   ("en", "fr"…). The tool's private part (/chest) speaks it to them; a
//   notification or an email to them is written in it.
// - timeZone is the IANA zone the member works in ("America/New_York"):
//   the one they chose in their profile, else their browser's, else the
//   Chest's. Show them times in it; remind them at their hour in it. The
//   company's day and business rules are the Chest's (chest.timeZone).
// - email is there only when the tool holds "members.email".
export type Member = {
  id: string;
  firstName: string;
  lastName: string;
  name: string;
  photo: string | null;
  role: string | null;
  isAdmin: boolean;
  isBuilder: boolean;
  groups: string[];
  language: string;
  timeZone: string;
  email?: string;
};
// What is the same for every member — the organization, the company's time
// zone — is the Chest's: the chest module.

// The grammars of the identifiers the Chest mints: a tool may check with them
// the identifiers it stores.
export const memberIdPattern = /^mbr_[a-z2-7]{26}$/u;
export const groupIdPattern = /^grp_[a-z2-7]{26}$/u;
// The grammar of a language the Chest gives: a primary tag, whichever the
// product speaks (a language added to the Chest needs no change here); of a
// zone: UTC, or an area and a location ("Europe/Paris",
// "America/Argentina/Buenos_Aires").
export const languagePattern = /^[a-z]{2,3}$/u;
export const timeZonePattern = /^(?:UTC|[A-Z][A-Za-z_]{1,31}(?:\/[A-Za-z0-9_+-]{1,31}){1,2})$/u;

// The key of the assertions is HMAC-SHA256 of this label under the text of
// CHEST_TOKEN, exactly as the Chest derives it (chest/toolfront). Its version
// changes when a claim changes meaning or goes, so that an assertion of
// another shape is refused rather than misread; a claim added keeps it, as a
// reader of the former claims still reads them. The signature, the
// audience and the time window are read as for everything the Chest signs
// (signed.ts).
const label = "Chest-Member v2";
// The claims every assertion carries; email only for a tool that holds
// members.email.
const claims = ["iss", "aud", "iat", "exp", "sub", "given_name", "family_name", "name", "picture", "role", "admin", "builder", "groups", "language", "time_zone"] as const;
// An assertion is a few hundred bytes; anything longer is not one.
const maxLength = 8192;

// member returns who the Chest says is making this request, or null when the
// request carries no valid assertion — absent, malformed, signed with another
// key or for another shape, for another tool, expired or not yet valid —, or
// when CHEST_TOKEN or CHEST_TOOL is missing. It never throws for what a
// request carries. Only the Chest's front reaches the tool; the signature is a
// second defence, and the tool still decides what a member may do with its
// own rules.
export function member(request: IncomingMessage | Request): Member | null {
  const payload = signedClaims(headerValue(request, "chest-member", maxLength), label);
  if (!payload || !claims.every(name => Object.hasOwn(payload, name))) return null;
  const { iss, sub, given_name, family_name, name, email, picture, role, admin, builder, groups, language, time_zone } = payload;
  if (typeof iss !== "string" || iss === "" || typeof sub !== "string" || !memberIdPattern.test(sub)) return null;
  if (typeof given_name !== "string" || typeof family_name !== "string" || typeof name !== "string" || typeof picture !== "string" || typeof role !== "string" || typeof admin !== "boolean" || typeof builder !== "boolean") return null;
  if (!Array.isArray(groups) || groups.length > 16 || !groups.every(g => typeof g === "string" && groupIdPattern.test(g)) || (email !== undefined && typeof email !== "string")) return null;
  if (typeof language !== "string" || !languagePattern.test(language) || typeof time_zone !== "string" || !timeZonePattern.test(time_zone)) return null;
  return { id: sub, firstName: given_name, lastName: family_name, name, photo: picture === "" ? null : picture, role: role === "" ? null : role, isAdmin: admin, isBuilder: builder, groups: [...groups] as string[], language, timeZone: time_zone, ...(email === undefined ? {} : { email }) };
}
