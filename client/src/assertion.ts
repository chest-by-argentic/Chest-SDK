import { createHmac } from "node:crypto";

// What the Chest-Member assertion is made of, shared by the module that reads
// it (member.ts) and the one that signs it for a tool's tests (testing.ts).
// Not a published module.

// The grammars of the identifiers the Chest mints.
export const memberIdPattern = /^mbr_[a-z2-7]{26}$/u;
export const groupIdPattern = /^grp_[a-z2-7]{26}$/u;

// The key of the assertions is HMAC-SHA256 of this label under the text of
// CHEST_TOKEN, exactly as the Chest derives it (chest/toolfront). Its version
// is the shape of the claims: an assertion of another shape is refused.
const label = "Chest-Member v2";

// assertionKey is the key the assertions of an instance are signed with.
export function assertionKey(token: string): Buffer {
  return createHmac("sha256", Buffer.from(token, "utf8")).update(label).digest();
}

// The claims every assertion carries; email only for a tool that holds
// members.email.
export const claims = ["iss", "aud", "iat", "exp", "sub", "given_name", "family_name", "name", "picture", "role", "admin", "builder", "groups"] as const;
