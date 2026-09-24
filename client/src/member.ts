import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

// The member the Chest asserts on a request of the team host of a server
// tool (/chest and below), read from the Chest-Member header. photo and role
// are absent when the Chest names none.
export type Member = {
  id: string;
  firstName: string;
  lastName: string;
  name: string;
  email: string;
  photo?: string;
  role?: string;
  isAdmin: boolean;
  isBuilder: boolean;
};

// The key of the assertions is HMAC-SHA256 of this label under the text of
// CHEST_TOKEN, exactly as the Chest derives it (chest/toolfront).
const label = "Chest-Member v1";
// Clocks of the Chest and of the container may differ by this much, in seconds.
const skew = 5;
// An assertion is a few hundred bytes; anything longer is not one.
const maxLength = 8192;
const compact = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/u;
const claims = ["iss", "aud", "iat", "exp", "sub", "given_name", "family_name", "name", "email", "picture", "role", "admin", "builder"] as const;

function assertionOf(request: IncomingMessage | Request): string | null {
  const headers = request.headers as Headers | IncomingMessage["headers"];
  // A Web Request joins repeated headers with ", ", which no assertion
  // contains; a Node request keeps them as an array: both are refused.
  const value = typeof (headers as Headers).get === "function" ? (headers as Headers).get("chest-member") : (headers as IncomingMessage["headers"])["chest-member"];
  return typeof value === "string" && value.length <= maxLength ? value : null;
}

function json(part: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

// member returns who the Chest says is making this request, or null when the
// request carries no valid assertion — absent, malformed, signed with another
// key, for another tool, expired or not yet valid —, or when CHEST_TOKEN or
// CHEST_TOOL is missing. It never throws for what a request carries. Only the
// Chest's front reaches the tool; the signature is a second defence, and the
// tool still decides what a member may do with its own rules.
export function member(request: IncomingMessage | Request): Member | null {
  const token = process.env["CHEST_TOKEN"];
  const tool = process.env["CHEST_TOOL"];
  if (!token || !/^[A-Za-z0-9_-]{43,512}$/u.test(token) || !tool) return null;
  const assertion = assertionOf(request);
  const parts = assertion === null ? null : compact.exec(assertion);
  if (!parts) return null;
  const [, encodedHeader = "", encodedPayload = "", encodedSignature = ""] = parts;
  const header = json(encodedHeader);
  if (!header || Object.keys(header).length !== 2 || header["alg"] !== "HS256" || header["typ"] !== "JWT") return null;
  const key = createHmac("sha256", Buffer.from(token, "utf8")).update(label).digest();
  const expected = createHmac("sha256", key).update(encodedHeader + "." + encodedPayload).digest();
  const signature = Buffer.from(encodedSignature, "base64url");
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
  const payload = json(encodedPayload);
  if (!payload || !claims.every(name => Object.hasOwn(payload, name))) return null;
  const { iss, aud, iat, exp, sub, given_name, family_name, name, email, picture, role, admin, builder } = payload;
  if (typeof iss !== "string" || iss === "" || aud !== tool || typeof sub !== "string" || sub === "") return null;
  if (typeof iat !== "number" || !Number.isSafeInteger(iat) || typeof exp !== "number" || !Number.isSafeInteger(exp) || exp <= iat) return null;
  const now = Math.floor(Date.now() / 1000);
  if (iat > now + skew || exp <= now - skew) return null;
  if (typeof given_name !== "string" || typeof family_name !== "string" || typeof name !== "string" || typeof email !== "string" || typeof picture !== "string" || typeof role !== "string" || typeof admin !== "boolean" || typeof builder !== "boolean") return null;
  return { id: sub, firstName: given_name, lastName: family_name, name, email, ...(picture === "" ? {} : { photo: picture }), ...(role === "" ? {} : { role }), isAdmin: admin, isBuilder: builder };
}
