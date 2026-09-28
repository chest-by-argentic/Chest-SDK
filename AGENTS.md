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
| The tool's private files | `put`, `get`, `stat`, `list`, `move`, `delete`, `url`, `uploadUrl` from `@argentic/chest-sdk/files` | `"capabilities": ["files"]` in `chest.json` (and `"files": {"quota", "maxObject"}` beyond 1 GiB, 32 MiB per object) |
| Who else has the tool | `list`, `get`, `lookup`, `groups.list` from `@argentic/chest-sdk/members` | `"capabilities": ["members"]` (`"members.email"` too for addresses) |
| Be told when members change, lose access, leave or ask to be erased | `handle`, `verify`, `acknowledgeErasure` from `@argentic/chest-sdk/events` | `"capabilities": ["members"]` and `"receives": ["member.*"]` |
| Tell members what needs their attention | `notify`, `withdraw`, `badge.set`, `badge.setMany` from `@argentic/chest-sdk/notifications` | `"capabilities": ["notifications"]` |
| Typed errors | `ChestError`, `CapabilityNotGranted`, `TooLarge`, `QuotaExceeded`, `RateLimited`, `Unavailable` from `@argentic/chest-sdk/errors` | — |
| Tests without a Chest | `fakeChest` (and its `emit`), `withMember`, `signAssertion` from `@argentic/chest-sdk/testing` | tests only |

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

## Tell members what needs their attention

A badge is a count on the tool's tile, per member; a notification is an item
in the member's inbox inside the Chest, linking to a page of the tool.

```ts
// "capabilities": ["notifications"]
import * as notifications from "@argentic/chest-sdk/notifications";

// A task is assigned: one inbox item, keyed by the task, and the count.
await notifications.notify([task.assignee], { title: `New task: ${task.title.slice(0, 60)}`, path: `/chest/tasks/${task.id}`, key: `task:${task.id}` });
await notifications.badge.set(task.assignee, openTasks);

// The task is done: its item goes, the count follows.
await notifications.withdraw(`task:${task.id}`);
await notifications.badge.set(task.assignee, openTasks - 1);
```

- Key every notification about a thing that ends (a task, a request, a
  review): the same key replaces the item instead of piling up, and
  `withdraw(key)` removes it once handled.
- Titles are 1 to 80 characters, bodies 280: cut user text yourself before
  sending (the SDK refuses rather than truncates). Plain text only: no
  Markdown, no HTML, no links in the text — the link is `path`.
- `path` is under `/chest` (the tool's private part), never a full URL.
- A badge is a state: set it to the true count whenever it changes; 0 clears.
  Use `setMany` (500 at a time) after a batch change, not one `set` per row.
- `skipped` (or `badge.set` → `false`) means the member does not have the
  tool: not an error.
- Muting is invisible: a member who muted the tool is `delivered`. Never try
  to detect it.

## Keep in step with the members' lifecycle

The Chest posts events to the tool's `POST /chest-events` (outside `/chest`),
signed for it, at least once: `member.updated`, `access.revoked`,
`member.removed`, `member.erased`.

```ts
// app/chest-events/route.ts — "receives": ["member.*"] in chest.json
import * as events from "@argentic/chest-sdk/events";

export async function POST(request: Request) {
  return new Response(null, { status: await events.handle(request, {
    "access.revoked": e => sql`update tasks set assignee = null where assignee = ${e.data.id}`,
    "member.erased": async e => {
      await sql`update tasks set created_by = 'erased' where created_by = ${e.data.id}`;
      await events.acknowledgeErasure(e.data.erasure);
    },
  }, { seen }) }); // seen: {has, add} over a table chest_events(id primary key)
}
```

- The same event can come twice, with the same `id`: give `handle` a durable
  `seen` store and keep handlers idempotent. Order is not guaranteed.
- Answer the status `handle` returns; a handler that throws makes it throw —
  answer 500 and the Chest delivers again, for 72 hours.
- `members.list()` stays the truth: reconcile at start; events keep you
  current in between.
- On `member.erased`, delete or anonymise that person's data within 30 days,
  then `acknowledgeErasure(erasure)`: the owner sees it done per tool.
- Never put the route behind your own session or under `/chest`, and never
  read the body before `handle` (it verifies the signature over it).

## Let a member upload a file

The browser sends the bytes to the Chest itself; the tool only authorises one
upload and checks what came.

```ts
// app/chest/api/avatar/route.ts — authorise one upload
import { member } from "@argentic/chest-sdk/member";
import * as files from "@argentic/chest-sdk/files";

export async function POST(request: Request) {
  const who = member(request);
  if (!who) return new Response(null, { status: 401 });
  // A folder: the Chest names the object (20 hex characters + an extension).
  const up = await files.uploadUrl("photos/", { maxSize: 5 << 20, types: ["image/*"] });
  return Response.json(up); // { url, method: "PUT", expiresIn }
}
```

```ts
// In the browser, on a /chest page: the member's session goes with it
const sent = await fetch(up.url, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
const { name } = await sent.json(); // 201 {name, type, size}
// then tell the tool: it calls files.stat(name) (and checks the name is under
// photos/) before recording it in its database
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
- **Authorise uploads only in `/chest` routes, after `member()`.** The
  `uploadUrl()` answer goes to that member's browser, never to a public page;
  it serves once, within its `expiresIn`.
- **Record an uploaded file after `stat` confirms it.** The browser may never
  send it, or the Chest may refuse it: write the name in your database only
  once `files.stat(name)` returns it (its type and size as the Chest kept
  them).
- **Notify members, never others.** Only members with access receive
  anything; send member ids from your data, never addresses.
- **Mind the quotas.** 1,000 recipients an hour, 100 items per member a day,
  600 badge writes a minute: notify the people concerned, not everyone, and
  on `QuotaExceeded` wait (a refused call changed nothing).
- **Large files go through `uploadUrl`, not `put`.** `put` and `get` carry the
  bytes through the tool's memory (256 MiB by default).

## Common pitfalls

| Symptom | Cause |
|---|---|
| `member()` always returns `null` locally | No `CHEST_TOKEN` / `CHEST_TOOL` in the environment: outside a Chest, nobody is a member. |
| `CapabilityNotGranted` from `databaseUrl()` | Capability missing in `chest.json`, not approved yet, or `DATABASE_URL` set by the tool itself. |
| The browser's `PUT` answers 403 `invalid_token` | The upload token was already used, expired (`expiresIn`), or was not made for this host: ask a new `uploadUrl` for each upload. |
| The browser's `PUT` answers 415 `type_refused` or 400 `type_mismatch` | The file's `Content-Type` is not one of `types`, or its first bytes are not of the type sent. |
| `TooLarge` from `uploadUrl` or `put` | Beyond the tool's largest object (32 MiB unless `chest.json` asks `"files": {"maxObject": …}`). |
| `ChestError` with `invalid_name` | A file name outside the allowed shape (up to 8 segments of `[A-Za-z0-9._-]`, none starting with `.` or `-`). |
| `member.email` is always undefined | The tool does not hold `members.email`: addresses are a permission of their own. |
| `ChestError` with `invalid_title` | The title is empty (once control characters are removed) or longer than 80 characters. |
| `ChestError` with `invalid_path` | `path` is not `/chest` or under it (a full URL, `//`, `..`, a space or non-ASCII character). |
| `QuotaExceeded` from `notifications` | Beyond 1,000 recipients an hour, 100 items per member a day or 600 badge writes a minute; the call changed nothing. |
| `events.handle` always answers 401 | The body was read before `handle` (a body parser), or the environment is not the Chest's (`CHEST_TOKEN`, `CHEST_TOOL`; in a test, deliver with `fakeChest().emit`). |
| No event ever comes | `chest.json` does not declare `"receives": ["member.*"]` (with `members`), the version was not approved, or the route is not `POST /chest-events` at the root. |
| `ChestError` `erasure_not_found` from `acknowledgeErasure` | The erasure was not sent to this tool: acknowledge the `erasure` of the `member.erased` event you received. |
| `RateLimited` from `members` | More than 600 calls a minute: use `lookup` (200 ids a call, kept a minute) instead of one `get` per row. |
| Build fails in the browser bundle | The SDK was imported from client code. |

## Contributing to this package

Keep it dependency-free (`node:*` only), with no network access other than the
Chest's API on `127.0.0.1`, and run `npm test` and `npm run check:package`
before opening a pull request.
