import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

// What the Chest signs for a server tool — the events of its members and
// of other tools (events), the runs of its schedules (schedules), posted through its
// launcher only (never from the Internet), each on a route of its own —: one
// mechanism, shared by the modules that read it and by testing, which signs
// as the Chest. Not a published module. member.ts reads the Chest-Member
// assertion with the same steps in its own words: it imports nothing but
// node:*, so that a tool may vendor it alone (Forms does, and webpack does
// not resolve a relative ./x.js import to ./x.ts).
//
// The signature is a compact JWS, HS256, typ JWT, in the channel's header,
// under HMAC-SHA256 of the channel's label keyed by the text of CHEST_TOKEN,
// exactly as the Chest derives it (chest/toolfront) — neither the token
// itself nor the key of the Chest-Member assertion, and never another
// channel's: a delivery of one is never read as the other's. Its claims are
// the tool (aud), iat, exp, the identifier of what is posted (jti) and the
// SHA-256 of the body (digest, base64url).

// A channel: the header of its signature, the label its key derives from,
// the grammar of its identifiers and the largest body it carries.
export type Channel = { header: string; label: string; id: RegExp; maxBody: number };

// The events of the members and of other tools (events): POST /chest-events.
// A tool event names the members who may see it, up to a whole team: its
// body is bounded by the team's capacity — a full team's policy, 32 MiB —
// and its 64 KiB of envelope and data. Only the Chest makes a tool read that
// much: delivery reads no body before its signature holds.
export const eventChannel: Channel = { header: "Chest-Event", label: "Chest-Event v1", id: /^evt_[a-z2-7]{26}$/u, maxBody: (32 << 20) + (64 << 10) };
// The runs of the schedules (schedules): POST /chest-schedules.
export const scheduleChannel: Channel = { header: "Chest-Schedule", label: "Chest-Schedule v1", id: /^run_[a-z2-7]{26}$/u, maxBody: 1024 };

const claims = ["aud", "iat", "exp", "jti", "digest"] as const;
// Clocks of the Chest and of the container may differ by this much, in seconds.
const skew = 5;
const maxSignature = 2048;
const compact = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/u;

export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function json(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
// An instant as the Chest writes it (RFC 3339).
export const instant = (v: unknown): v is string => typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v));

// headerValue is the value of a header, maxLength at most; null for none,
// longer, or repeated (a Web Request joins repeated values with ", ", which
// no signature contains; a Node request keeps them as an array).
export function headerValue(request: IncomingMessage | Request, name: string, maxLength: number): string | null {
  const headers = request.headers as Headers | IncomingMessage["headers"];
  const value = typeof (headers as Headers).get === "function" ? (headers as Headers).get(name) : (headers as IncomingMessage["headers"])[name];
  return typeof value === "string" && value.length <= maxLength ? value : null;
}

// signedClaims reads what the Chest signed for this tool under a label: the
// claims of a compact JWS, HS256, typ JWT, under HMAC-SHA256 of the label
// keyed by the text of CHEST_TOKEN, when the signature holds, its audience
// is CHEST_TOOL and now is within iat and exp (5 s of skew each way); null
// otherwise, or outside a Chest. It never throws for what it is given.
export function signedClaims(value: string | null, label: string): Record<string, unknown> | null {
  const token = process.env["CHEST_TOKEN"];
  const tool = process.env["CHEST_TOOL"];
  if (!token || !/^[A-Za-z0-9_-]{43,512}$/u.test(token) || !tool) return null;
  const parts = value === null ? null : compact.exec(value);
  if (!parts) return null;
  const [, encodedHeader = "", encodedPayload = "", encodedSignature = ""] = parts;
  const header = object(json(Buffer.from(encodedHeader, "base64url").toString("utf8")));
  if (!header || Object.keys(header).length !== 2 || header["alg"] !== "HS256" || header["typ"] !== "JWT") return null;
  const key = createHmac("sha256", Buffer.from(token, "utf8")).update(label).digest();
  const expected = createHmac("sha256", key).update(encodedHeader + "." + encodedPayload).digest();
  const given = Buffer.from(encodedSignature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const payload = object(json(Buffer.from(encodedPayload, "base64url").toString("utf8")));
  if (!payload || payload["aud"] !== tool) return null;
  const { iat, exp } = payload;
  if (typeof iat !== "number" || !Number.isSafeInteger(iat) || typeof exp !== "number" || !Number.isSafeInteger(exp) || exp <= iat) return null;
  const now = Math.floor(Date.now() / 1000);
  return iat > now + skew || exp <= now - skew ? null : payload;
}

// signClaims is what the Chest would sign under a label for these claims
// (their aud, iat and exp included), with that token: for the fake Chest of
// a tool's tests (testing).
export function signClaims(label: string, claims: Record<string, unknown>, token: string): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signed = encode({ alg: "HS256", typ: "JWT" }) + "." + encode(claims);
  const key = createHmac("sha256", Buffer.from(token, "utf8")).update(label).digest();
  return signed + "." + createHmac("sha256", key).update(signed).digest("base64url");
}

// bodyOf reads the body, limit bytes at most; null beyond, or when it was
// read already.
async function bodyOf(request: IncomingMessage | Request, limit: number): Promise<Buffer | null> {
  try {
    if (request instanceof Request) {
      if (request.bodyUsed || Number(request.headers.get("content-length") ?? "0") > limit) return null;
      const raw = Buffer.from(await request.arrayBuffer());
      return raw.length <= limit ? raw : null;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > limit) return null;
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

// delivery reads a request of a channel: the identifier it was signed for
// and its body, when the signature, the tool, the time and the digest of
// the body hold; null otherwise — not a POST, no or another signature,
// another tool, expired, a body other than the one signed. It reads the
// body. It never throws for what a request carries.
export async function delivery(request: IncomingMessage | Request, channel: Channel): Promise<{ id: string; body: Buffer } | null> {
  if (request.method !== "POST") return null;
  const payload = signedClaims(headerValue(request, channel.header.toLowerCase(), maxSignature), channel.label);
  if (!payload || Object.keys(payload).length !== claims.length || !claims.every(name => Object.hasOwn(payload, name))) return null;
  const { jti, digest } = payload;
  if (typeof jti !== "string" || !channel.id.test(jti) || typeof digest !== "string") return null;
  const body = await bodyOf(request, channel.maxBody);
  if (body === null) return null;
  const sum = createHash("sha256").update(body).digest();
  const told = Buffer.from(digest, "base64url");
  if (told.length !== sum.length || !timingSafeEqual(told, sum)) return null;
  return { id: jti, body };
}

// sign is the value of a channel's header the Chest would send with that
// body: for the fake Chest of a tool's tests (testing).
export function sign(channel: Channel, id: string, body: string, options: { token: string; tool: string }): string {
  const iat = Math.floor(Date.now() / 1000);
  return signClaims(channel.label, { aud: options.tool, iat, exp: iat + 60, jti: id, digest: createHash("sha256").update(body).digest("base64url") }, options.token);
}

// Where a handler remembers the identifiers of the deliveries already
// handled: a store the tool chooses. Keep it durable — a table of the
// tool's database — so a delivery made again after a restart of the tool is
// recognised:
//
//   create table chest_seen (id text primary key, at timestamptz not null default now());
//   const seen = {
//     has: async (id: string) => (await sql`select 1 from chest_seen where id = ${id}`).length > 0,
//     add: async (id: string) => { await sql`insert into chest_seen (id) values (${id}) on conflict do nothing`; },
//   };
export type Seen = { has(id: string): boolean | Promise<boolean>; add(id: string): void | Promise<void> };

// memorySeen keeps the last limit ids in this process: lost at a restart,
// enough for a tool whose handlers are idempotent anyway.
export function memorySeen(limit = 10000): Seen {
  const ids = new Set<string>();
  return {
    has: id => ids.has(id),
    add: id => {
      ids.delete(id);
      ids.add(id);
      while (ids.size > limit) ids.delete(ids.values().next().value as string);
    },
  };
}
