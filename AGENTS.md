# Using `@argentic/chest-sdk` — a guide for AI agents

This file is for an AI coding agent (and its developer) building a **Chest
server tool** with this package. `README.md` is the full reference; this page
is the short path and the mistakes to avoid.

## What it is

A Chest server tool (tool contract v2) is an ordinary web server that runs in
a container without network, started by its Chest. The SDK gives it, all
server-side:

| Need | Import | Requires |
|---|---|---|
| Who is signed in on this request | `member(request)` from `@argentic/chest-sdk/member` | nothing (the Chest sets `CHEST_TOKEN`, `CHEST_TOOL`) |
| The tool's own PostgreSQL database | `databaseUrl()` from `@argentic/chest-sdk/database` | `"capabilities": ["database"]` in `chest.json` |
| The tool's private files | `put`, `get`, `list`, `delete`, `url` from `@argentic/chest-sdk/files` | `"capabilities": ["files"]` in `chest.json` |
| Who else has the tool | `list`, `get`, `lookup`, `groups.list` from `@argentic/chest-sdk/members` | `"capabilities": ["members"]` (`"members.email"` too for addresses) |
| Typed errors | `ChestError`, `CapabilityNotGranted`, `TooLarge`, `QuotaExceeded`, `RateLimited`, `Unavailable` from `@argentic/chest-sdk/errors` | — |
| Tests without a Chest | `fakeChest`, `withMember`, `signAssertion` from `@argentic/chest-sdk/testing` | tests only |

## Install

```sh
npm install @argentic/chest-sdk
```

Node 22 or later, ESM only, no runtime dependency. TypeScript projects need
`@types/node`; `moduleResolution` `bundler` and `nodenext` both work.

## Minimal tool

```jsonc
// chest.json (repository root)
{ "capabilities": ["database", "files"] }
```

```ts
// app/chest/api/me/route.ts (Next.js route handler)
import { member } from "@argentic/chest-sdk/member";

export function GET(request: Request) {
  const who = member(request);
  return who ? Response.json(who) : new Response(null, { status: 401 });
}
```

```ts
import postgres from "postgres";
import { databaseUrl } from "@argentic/chest-sdk/database";
const sql = postgres(databaseUrl(), { max: 5 });
```

```ts
import * as files from "@argentic/chest-sdk/files";
await files.put("reports/2026.pdf", bytes, "application/pdf");
const { url } = await files.url("reports/2026.pdf"); // 15-minute signed link
```

```ts
// "capabilities": ["members"]: store member ids, resolve names when rendering.
import * as members from "@argentic/chest-sdk/members";
const rows = await sql`select * from tasks order by id desc limit 50`;
const people = await members.lookup(rows.map(r => r.assignee).filter(Boolean));
```

```ts
// A test of the tool, with no Chest running.
import { fakeChest, withMember } from "@argentic/chest-sdk/testing";
const chest = await fakeChest({ members: [camille] });
const response = await GET(withMember(new Request("http://tool.test/chest/api/me"), camille));
await chest.close();
```

Schema changes go in `migrations/NNNN_name.sql`; the Chest runs them in order
at install and at every update.

## Rules that keep a tool correct

- **Server only.** Never import the SDK in a `"use client"` module or ship it
  to a browser: it reads secrets from the environment.
- **`member()` is the only source of identity.** Check it on every request
  under `/chest`; `null` means "not a member" — answer 401/403. Never trust a
  user id, email or role sent in a body, query or cookie of your own.
- **Store member ids, never names or addresses.** `member.id` (`mbr_…`) is
  stable and the same in every tool of the Chest; names and addresses change.
  Resolve them when rendering with `members.lookup`; a `former` answer is
  someone who left (“Camille Martin (former member)”).
- **A member without access does not exist for the tool.** `members.get`
  answers `null` and `lookup` puts the id in `unknown`, exactly as for an id
  that was never a member.
- **The public host has no member.** The Chest never sends an assertion there;
  public pages must work for anonymous visitors.
- **Business rules are yours.** The SDK is not a security boundary: the Chest
  enforces capabilities, but who may edit what inside your tool is your code.
- **`databaseUrl()` is a secret.** Never log it, never send it to a browser.
- **Do not retry an uncertain write.** `Unavailable` means the Chest was not
  reached or did not answer as expected: the write may or may not have
  happened. Re-read before writing again.
- **Handle `CapabilityNotGranted`.** It is thrown when `chest.json` does not
  declare the capability or the version was not approved; show a clear message
  instead of crashing.
- **Keep migrations backward compatible.** A rollback does not undo a
  migration: the previous version must keep working on the new schema. Never
  edit or delete a migration that already ran.
- **No network, no local disk.** The container has no outbound network and a
  read-only root; store files through `files`, data in the database.
- **Give signed file links only to members.** A `files.url()` link opens
  without sign-in for 15 minutes; never put it on a public page.

## Common pitfalls

| Symptom | Cause |
|---|---|
| `member()` always returns `null` locally | No `CHEST_TOKEN` / `CHEST_TOOL` in the environment: outside a Chest, nobody is a member. |
| `CapabilityNotGranted` from `databaseUrl()` | Capability missing in `chest.json`, not approved yet, or `DATABASE_URL` set by the tool itself. |
| `ChestError` with `invalid_name` | A file name outside the allowed shape (up to 8 segments of `[A-Za-z0-9._-]`, none starting with `.` or `-`). |
| `member.email` is always undefined | The tool does not hold `members.email`: addresses are a permission of their own. |
| `RateLimited` from `members` | More than 600 calls a minute: use `lookup` (200 ids a call, kept a minute) instead of one `get` per row. |
| Build fails in the browser bundle | The SDK was imported from client code. |

## Contributing to this package

Keep it dependency-free (`node:*` only), with no network access other than the
Chest's API on `127.0.0.1`, and run `npm test` and `npm run check:package`
before opening a pull request.
