# Using `@argentic/chest-sdk` — a guide for AI agents

This file is for an AI coding agent (and its developer) building a **Chest
server tool** with this package. `README.md` is the full reference; this page
is the short path and the mistakes to avoid.

## What it is

A Chest server tool (tool contract 0.5) is an ordinary web server that runs in
a container without network, started by its Chest. The SDK gives it, all
server-side:

| Need | Import | Requires |
|---|---|---|
| Who is signed in on this request, the language to speak to them | `member(request)` from `@argentic/chest-sdk/member` | nothing (the Chest sets `CHEST_TOKEN`, `CHEST_TOOL`) |
| The Chest itself: its organization's name, its time zone and today's date there, its language, its currency — on a request or not | `chest` from `@argentic/chest-sdk/chest` | nothing (the Chest sets `CHEST_ORGANIZATION`, `CHEST_TIME_ZONE`, `CHEST_LANGUAGE`, `CHEST_CURRENCY`) |
| The tool's own addresses, for links in an email or a feed | `chest.tool.teamUrl`, `chest.tool.publicUrl` from `@argentic/chest-sdk/chest` | nothing (`CHEST_TEAM_URL`, `CHEST_PUBLIC_URL` with `"public": true`) |
| Will the Chest take this repository? | `npx chest check` (`--json`) from `@argentic/chest-check` | a clone of Chest-SDK (`check/`, not on npm yet), a Git repository |
| The tool's own PostgreSQL database | `databaseUrl()` from `@argentic/chest-sdk/database` | `"capabilities": ["database"]` in `chest.json` |
| Sensitive values (an IBAN, a salary, a confidential message) that only members open, never the Data tab, agents or backups | `seal`, `sealMany`, `open`, `openMany`, `isSealed` from `@argentic/chest-sdk/sealed` | `"capabilities": ["sealed"]` (and `"roles"` to seal for some) |
| The tool's private files | `put`, `get`, `stat`, `list`, `move`, `delete`, `url`, `uploadUrl` from `@argentic/chest-sdk/files` | `"capabilities": ["files"]` in `chest.json` (and `"files": {"quota", "maxObject"}` beyond 1 GiB, 32 MiB per object) |
| Who else has the tool | `list`, `get`, `lookup`, `groups.list` from `@argentic/chest-sdk/members` | `"capabilities": ["members"]` (`"members.email"` too for addresses, `"members.groups"` for every group of the Chest — a tool open to everyone that offers “the Sales team”) |
| Be told when members change, lose access, leave or ask to be erased | `handle`, `verify`, `acknowledgeErasure` from `@argentic/chest-sdk/events` | `"capabilities": ["members"]` and `"receives": ["member.*"]` |
| Tell other tools what happened (a quote accepted), and be told what they tell | `emit`, `handle` from `@argentic/chest-sdk/events` | `"emits": {"quote.accepted": {"description", "data": {field: kind}}}` to tell; `"receives": ["quote.accepted"]` to be told |
| Do work by itself at set times (digests, reminders, purges) | `handle`, `verify` from `@argentic/chest-sdk/schedules` | `"schedules": [{"name", "cron"}]` in `chest.json` |
| Tell members what needs their attention — some, or everyone who has the tool, or some groups or roles | `notify`, `broadcast`, `withdraw`, `badge.set`, `badge.setMany` from `@argentic/chest-sdk/notifications` | `"capabilities": ["notifications"]` |
| Call AI models (chat, streamed or not, tools, embeddings) | `chat`, `embed`, `models`, `usage` from `@argentic/chest-sdk/ai` | `"capabilities": ["ai"]` and `"ai": {"monthly", "models", "purpose"}` |
| Keep the members' pages live (chat, presence, typing, rows as they are written) | `connect` from `@argentic/chest-sdk/realtime/client` **in the browser**; `publish`, `send`, `online`, `presence` from `@argentic/chest-sdk/realtime` on the server | `"capabilities": ["realtime"]` and `"realtime": {"channels", "feeds"}` |
| Typed errors | `ChestError`, `CapabilityNotGranted`, `TooLarge`, `QuotaExceeded`, `RateLimited`, `Unavailable`, `MemberRequired`, `NotAllowed`, `SealedInvalid`, `SealedLocked`, `SealedLost`, `AiCapReached`, `AiUnavailable`, `AiModelNotAllowed`, `AiRefused` from `@argentic/chest-sdk/errors` | — |
| Tests without a Chest | `fakeChest` (its `deliver`, `emitted`, `emits`, `run`, its links and uploads, its `realtime`, `chest: {organization, timeZone, language, currency, teamUrl, publicUrl}`), `withMember`, `signAssertion` from `@argentic/chest-sdk/testing` | tests only |

## Install

```sh
npm install @argentic/chest-sdk
```

Node 22 or later, ESM only, no runtime dependency. TypeScript projects need
`@types/node`; `moduleResolution` `bundler` and `nodenext` both work.

## Minimal tool

```jsonc
// chest.json (repository root): every key and its rule in contract/README.md
{
  "chest": "0.5",
  "name": "tasks",
  "capabilities": ["database", "files"],
  "build": { "runtime": "node", "install": "npm ci", "command": "npm run build", "start": "npm start", "port": 3000 }
}
```

```sh
npm install --save-dev /path/to/Chest-SDK/check   # a clone of this repository, after npm ci there
npx chest check   # before every push: the Chest's own verdict on the repository
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

## Tell other tools, and be told

One tool reacts to what happens in another: a quote accepted in Quotes
creates a project in Tasks. The publisher declares each type it tells, in a
sentence, with the fields of its data; the receiver names the types it
wants, never a tool. The owner approves each link at installation.

```jsonc
// chest.json of Quotes
{ "emits": { "quote.accepted": { "description": "A quote is accepted",
    "data": { "quote": "id", "client": "text", "total": "number", "acceptedBy": "member", "note": "text?" } } } }
// chest.json of Tasks
{ "receives": ["member.*", "quote.accepted"] }
```

```ts
// Quotes, once the quote is accepted in the database:
await events.emit("quote.accepted", { quote: q.id, client: q.client, total: q.total, acceptedBy: who.id },
  { subject: q.id, key: `accepted:${q.id}`, audience: { groups: q.groups } });

// Tasks, in the same POST /chest-events handler as the members' events:
"quote.accepted": async e => { await createProject(String(e.data["quote"]), e.audience === "all" ? null : e.audience); },
```

- Data is the declared fields only (kinds `id`, `text`, `number`,
  `boolean`, `time`, `date`, `member`, `members`, `?` when optional), 16 KiB
  at most; people as member ids, never names nor addresses.
- **Honour the audience.** `e.audience` is `"all"` or the list of your
  members who may see the item in the publisher: show it to them only. Give
  `audience` to `emit` whenever the item is not for everyone who has your
  tool.
- **Key every emit about a thing** (`key`): emit again with the same key
  after `Unavailable`, never a new one — the Chest tells nobody twice.
  `subject` keeps a thing's events in order for each receiver.
- **Read `e.data` defensively**: a publisher's next version may add fields;
  check each value you use (`String(...)`, `Number(...)`).
- Emitting from a handler is fine: the cause goes with it by itself and the
  Chest cuts loops. A tool never receives its own events.
- A type's data only grows: a new shape is a new type
  (`quote.accepted.v2`), emitted alongside the old one while receivers move.
- Test with `fakeChest({ emits })`: `chest.emitted` lists what the tool
  told, checked as the Chest checks it; `chest.deliver({ type, source,
  data, audience?, subject? }, tool)` delivers another tool's event.

## Do work at set times

Nothing runs in the tool between requests (an unused tool sleeps): the
Chest calls it. Declare each schedule; the line is read on the Chest's
clock (`chest.timeZone`).

```jsonc
// chest.json
{ "schedules": [{ "name": "morning", "cron": "30 7 * * 1-5" }] }
```

```ts
// app/chest-schedules/route.ts — outside /chest, never behind a session
import * as schedules from "@argentic/chest-sdk/schedules";

export async function POST(request: Request) {
  return new Response(null, { status: await schedules.handle(request, {
    morning: async () => { await remindDueToday(); },
  }, { seen }) }); // seen: the same {has, add} store as events
}
```

- Five fields, numbers, `*`, ranges, lists and steps; 8 schedules at most,
  each 15 minutes apart at least; no `@daily`, no day names.
- Answer when the work is done, within 5 minutes. A throw → 500 → the same
  run (same `run.id`) again after 1, 5, 15 minutes; keep handlers
  idempotent. A long job: a batch per run, its place kept in the database.
- A missed time (server stopped) runs once, late; runs never overlap.
- Per-member hours ("8:00 for each member"): run hourly and select the
  members whose `timeZone` makes it 8:00.
- Never put the route behind your own session or under `/chest`, and never
  read the body before `handle`.
- Test with `fakeChest().run("morning", request => app(request))`.

## Use AI models

The Chest's owner connects OpenRouter; the Chest leads the aliases
`default`, `fast`, `smart`, `embedding` to models; the tool names an alias, never a
model, and holds no key. Every call counts against the tool's monthly cap.

```jsonc
// chest.json
{ "capabilities": ["ai"], "ai": { "monthly": 20, "models": ["default", "embedding"], "purpose": "Summarises support tickets" } }
```

```ts
import * as ai from "@argentic/chest-sdk/ai";
import { AiCapReached, AiUnavailable } from "@argentic/chest-sdk/errors";

let summary: string | null = null;
try {
  summary = (await ai.chat({ model: "default", messages: [{ role: "user", content: `Summarise: ${ticket.text}` }], maxTokens: 300, member: who.id })).text;
} catch (error) {
  if (!(error instanceof AiCapReached || error instanceof AiUnavailable)) throw error;
  // summary stays null: the page says "AI features are paused" and still works
}

for await (const chunk of ai.chat({ model: "fast", messages, stream: true, signal: request.signal })) write(chunk.text);
const { embeddings } = await ai.embed({ model: "embedding", input: texts }); // 1 to 256 texts
```

- **Always degrade gracefully.** Catch `AiCapReached` and `AiUnavailable`
  around every AI call and keep the tool usable without AI; tell the member
  “AI features are paused”, never show a crash.
- Only aliases listed in `"ai": {"models"}` work (`AiModelNotAllowed`
  otherwise); add `embedding` there before calling `embed`.
- Set `maxTokens` to what the answer needs: the Chest reserves the worst case
  against the cap before each call, so a large `maxTokens` is refused sooner.
- Tool calls: add `result.message` to the conversation, run each of
  `result.toolCalls` yourself (`arguments` is JSON text, validate it), answer
  with `{role: "tool", tool_call_id, content}`, call again. The Chest never
  runs a tool.
- Streaming: pass the request's `signal` so a member who leaves stops the
  call; in a stream, join `toolCalls` pieces by `index`; the last chunk
  carries `usage`.
- Never put model output in a page as HTML, and never let it decide who may
  do what: it is text from outside the tool.
- Test both paths with `fakeChest({ ai: { reply, cap, unavailable } })`:
  `reply(request)` returns the text or `{text, toolCalls}` (the last user
  message echoed by default), `cap: 0` makes every call `AiCapReached`,
  `unavailable: "no_connector"` every call `AiUnavailable`; `chest.ai` lists
  the calls.

## Keep pages live

The Chest holds every page's connection; the tool writes rows as always and
sleeps meanwhile. Declare the channels and the tables whose writes are
events; no socket code, no token, no polling.

```jsonc
// chest.json
{
  "capabilities": ["database", "realtime"],
  "realtime": {
    "channels": [
      { "name": "everyone", "presence": true },
      { "name": "room:{id}", "join": { "table": "room_members", "key": "room_id", "member": "member_id" }, "send": true, "presence": true },
      { "name": "inbox:{member}" }
    ],
    "feeds": [{ "table": "messages", "channel": "room:{room_id}", "columns": ["id", "room_id", "author", "text", "created_at"] }]
  }
}
```

```ts
// In the page's own script (the one SDK module made for the browser)
import { connect } from "@argentic/chest-sdk/realtime/client";
const room = connect().channel("room:42");
room.onJoined(({ replayed }) => replayed || load());   // fetch once joined, unless what was missed came again
room.on("messages.insert", row => add(row));           // the Chest's events only: dedupe by id
room.onResync(() => load());
room.peers.on("typing", (_, from) => showTyping(from)); // other members' messages, apart
room.peers.send("typing");                             // no dot in the name
room.presence.track({ active: true });
```

```ts
// On the server, for what is not a row
import * as realtime from "@argentic/chest-sdk/realtime";
const { online, watching } = await realtime.online(memberIds, { channel: "room:42" }); // notify all but those watching
await realtime.publish("inbox:" + id, "rooms.changed", { room: 42 });
```

- Who joins is the manifest's rule, checked by the Chest without the tool:
  every member, some roles, or a membership table — insert a row to let
  someone in, delete it to take them out (at once).
- A feed's columns are sent to everyone in the channel: never list a column
  some of them may not read; put rows on channels whose members may see them.
- The database is the truth. A page that comes back is given every row it
  missed (7 days) and the tool's events of the last 2 minutes, by itself:
  fetch on `joined` unless `replayed`, and on `resync`; render text, never
  HTML.
- The client hides cuts: `status` false only after 3 s away, `closed` only
  for a member signed out or without access (reload, or say so).
- Write through the tool's own HTTP routes (`POST /chest/api/…`), which
  check `member()`; the socket only reads, but for ephemeral `peers.send`.
- A member's message comes only through `peers.on`, with its sender, never
  through `on` (the feeds' rows and the tool's publishes); the channel's
  life is `onJoined`, `onResync`, `onKicked`, `onRefused`, never an event.
- Call `live.focus(channel)` when a conversation is on screen (`null` when
  none): `realtime.online(ids, { channel })` then says who is `watching`
  it — notify the members online but not watching, and those not online.
- Test with `fakeChest({ capabilities: [..., "realtime"], realtime: { channels, feeds, membership } })`:
  `chest.realtime.commit("messages", "insert", row)`, `chest.realtime.published`,
  a page as `connect({ url: chest.realtime.url(memberId) })`, a page away
  with `drop(memberId)` and `advance(ms)` (the Chest's clock), `signOut`,
  `full(seconds)` (`full(seconds, "joins")`), `renewals`. `commit` takes the
  whole row and runs every feed of its table, as the Chest's triggers.

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

## Let a visitor send a file (a CV, a screenshot)

A tool with `"public": true` authorises a visitor's upload from a public
route, with `public: true`: into a folder, of types the Chest recognises by
their content (images, PDF, Office and OpenDocument documents, archives).

```ts
// app/api/apply/upload/route.ts — a public route: no member()
const up = await files.uploadUrl("applications/", { public: true, types: ["application/pdf"], maxSize: 10 << 20 });
return Response.json(up); // { url: "/_chest/files/upload/<token>", method: "PUT", expiresIn }
```

```ts
// In the browser, on the public page (or the company's site framing it)
const sent = await fetch(up.url, { method: "PUT", body: file }); // 201 {name, type, size}, 429 slow_down…
// then post the name with the form; the tool stats it, checks it is under
// applications/, and records it. Only members ever see the file.
```

Schema changes go in `migrations/NNNN_name.sql`; the Chest runs them in order
at install and at every update.

## Rules that keep a tool correct

- **Server only.** Never import the SDK in a `"use client"` module or ship it
  to a browser: it reads secrets from the environment — but
  `@argentic/chest-sdk/realtime/client`, made for the browser.
- **No polling, no socket of your own.** A page that must stay up to date
  uses realtime: polling keeps the tool awake as long as a tab is open, and
  the container has no WebSocket server reachable.
- **Speak the member's language.** In `/chest`, render in `member.language`
  (`"en"`, `"fr"`…; its own default for one it does not speak) and offer no
  language switch there; only public pages keep their own switch.
- **Store in UTC, decide in the Chest's zone, show in the member's.** Store
  instants as `timestamptz`. “Today”, “this week”, a deadline's day and
  business hours are the company's: `chest.today()`, `chest.timeZone` —
  never `new Date().toISOString().slice(0, 10)` (UTC's day) nor a zone
  written in the code; the database's `current_date` is already the Chest's
  day. Times shown to a member, and their personal reminders, are in
  `member.timeZone` (from `member(request)`, or `members.get` outside their
  request).
- **The company's name is the Chest's.** Show `chest.organization.name`
  (plain text, never HTML); never ask your own admin for it.
- **`member()` is the only source of identity.** Check it on every request
  under `/chest`; `null` means "not a member" — answer 401/403. Never trust a
  user id, email or role sent in a body, query or cookie of your own.
- **Store member ids, never names or addresses.** `member.id` (`mbr_…`) is
  stable and the same in every tool of the Chest; names and addresses change.
  Resolve them when rendering with `members.lookup`; a `former` answer is
  someone the tool no longer has: `no_access` (“Léa Dubois (no access)”),
  `former` (“Camille Martin (former member)”) or `erased` (“Former member”).
- **A member without access is not the tool's to list.** `members.list`
  and `members.get` see only those who have the tool; `lookup` keeps the
  name of someone the tool had (`no_access`) so their records keep an
  author, and answers `unknown` for anyone the tool never had.
- **Links in an email or a feed come from `chest.tool`.** Where no request
  tells the host (a scheduled job, a digest), write `new URL(path,
  chest.tool.teamUrl)` for members, `chest.tool.publicUrl` for visitors; never
  a host read from a header, never an address stored in the database.
- **Amounts are in `chest.currency`.** Never ask your own admin for the
  company's currency.
- **The public host has no member.** The Chest never sends an assertion there;
  public pages must work for anonymous visitors.
- **Business rules are yours.** The SDK is not a security boundary: the Chest
  enforces capabilities, but who may edit what inside your tool is your code.
- **`databaseUrl()` is a secret.** Never log it, never send it to a browser.
- **Seal what must stay between a member and the tool** (an IBAN, a payslip
  amount, a medical note) with `seal(value, {context, roles?})`, the context
  the row's kind and key; open it with `open(request, …)` in a `/chest`
  route, on the member's request, only what the page shows. Never seal what
  lists, sorts or searches need, never log or forward what you opened.
  `MemberRequired` means no member is there (a public page, a schedule).
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
- **Authorise members' uploads only in `/chest` routes, after `member()`.**
  The `uploadUrl()` answer goes to that member's browser, never to a public
  page; it serves once, within its `expiresIn`. A public page asks
  `uploadUrl(folder, {public: true, types})`: a visitor's file, into a folder
  of its own, of a type the Chest recognises.
- **An embeddable public page keeps its state in the page.** Framed by the
  company's website, cookies are third-party and blocked unless
  `SameSite=None; Secure; Partitioned`: carry what a form needs in its
  fields.
- **Record an uploaded file after `stat` confirms it.** The browser may never
  send it, or the Chest may refuse it: write the name in your database only
  once `files.stat(name)` returns it (its type, size and `sha256` as the
  Chest kept them: the digest detects a file sent twice without reading it).
- **Write to each member in their language.** Give a notification's words in
  every language you speak (`translations: {fr: {title, body}}`): the Chest
  gives each member theirs, your own words otherwise. Show a member's times
  in their `timeZone` (`members.get(id)` or `lookup` for another member).
- **Reach members by notifications, never by mail.** A reminder or an
  approval to give is a `notify` with a `key`. Members may get mails of
  their notifications, by their own choice: the Chest sends them, the tool
  does nothing — it keeps no email preference and sends no reminder mail of
  its own.
- **Page every list, and handle `member.groups === null`.** No count
  bounds a team: read `members.list` and `groups.list` page after page
  (`next`). A member in more groups than travel with a request (about 150)
  has `groups: null`: read them with `members.get(member.id)`.
- **Tell a group or everyone with `broadcast`**, never by listing members
  and notifying them in batches: the Chest resolves who has the tool now,
  in which group or role, and leaves out `except` (the author). It answers
  nothing; decide in your code who may trigger it (a role).
- **Notify members, never others.** Only members with access receive
  anything; send member ids from your data, never addresses.
- **Notify at a human pace.** Nothing is refused, but beyond ten at once to a
  member, then one every six minutes, the Chest folds your notices into one
  “37 new notifications” item: give each its own words only when it matters,
  and use a `key` for what updates (a replacement is never folded).
- **Large files go through `uploadUrl`, not `put`.** `put` and `get` carry the
  bytes through the tool's memory (256 MiB by default).

## Common pitfalls

| Symptom | Cause |
|---|---|
| `member()` always returns `null` locally | No `CHEST_TOKEN` / `CHEST_TOOL` in the environment: outside a Chest, nobody is a member. |
| `ChestError` `not_in_chest` from `chest` | No `CHEST_ORGANIZATION` / `CHEST_TIME_ZONE` / `CHEST_LANGUAGE` in the environment: in a test, start a `fakeChest`; on a development server, set them. |
| Dates one day off late in the evening | The day computed in UTC (`toISOString()`) or in a zone written in the code: use `chest.today()`. |
| A member abroad sees times shifted by hours | Times formatted in the Chest's zone or the server's: format with `timeZone: member.timeZone`. |
| `CapabilityNotGranted` from `databaseUrl()` | Capability missing in `chest.json`, not approved yet, or `DATABASE_URL` set by the tool itself. |
| The browser's `PUT` answers 403 `invalid_token` | The upload token was already used, expired (`expiresIn`), or was not made for this host: ask a new `uploadUrl` for each upload. |
| The browser's `PUT` answers 415 `type_refused` or 400 `type_mismatch` | The file's `Content-Type` is not one of `types`, or its first bytes are not of the type sent; for a visitor, its content is of none of `types`, whatever it is called. |
| The browser's `PUT` answers 429 `slow_down` | A visitor sent too many files (10 a minute, a twentieth of the quota an hour): wait `Retry-After` seconds. |
| `ChestError` `invalid_type` from `uploadUrl(…, {public: true})` | No `types`, or one the Chest cannot recognise by its content (plain text, CSV…). |
| `TooLarge` from `uploadUrl` or `put` | Beyond the tool's largest object (32 MiB unless `chest.json` asks `"files": {"maxObject": …}`). |
| `ChestError` with `invalid_name` | A file name outside the allowed shape (up to 8 segments of `[A-Za-z0-9._-]`, none starting with `.` or `-`). |
| `member.email` is always undefined | The tool does not hold `members.email`: addresses are a permission of their own. |
| `ChestError` with `invalid_title` | The title is empty (once control characters are removed) or longer than 80 characters. |
| The Chest refuses the repository: `newer_chest` | `chest.json` names a later contract than the Chest serves (`"chest"`): the Chest must be updated first. |
| The Chest refuses the repository: `manifest` | A key the contract does not have (a typo, or a key of a later contract), a missing `"chest"`, or a value outside its rule: `npx chest check` says which. |
| The Chest refuses the repository: `migrations` | A file of `migrations/` not named `NNNN_name.sql`, not SQL text, or migrations without the capability `database`. |
| `ChestError` with `invalid_path` | `path` is not `/chest` or under it (a full URL, `//`, `..`, a space or non-ASCII character). |
| `realtime/client` never connects | The page is not on the tool's team host (`/chest`), the version lacks `"realtime"` in its capabilities or was not approved, or the connection is from another site. |
| `ChestError` `invalid_channel` from `realtime.publish` | No pattern of `"realtime": {"channels"}` matches the name (a typo, an uppercase letter, a segment of more than 64 characters). |
| `TypeError` `invalid_event` from `peers.send` | A member's message is named 1 to 64 of `a-z 0-9 _ -`, without a dot: dotted names are the feeds' rows and the tool's events (`typing`, not `room.typing`). |
| A member's message never reaches `on` | It reaches `peers.on(event, (payload, from) => …)`: `on` hears only the Chest's events. |
| `events.handle` always answers 401 | The body was read before `handle` (a body parser), or the environment is not the Chest's (`CHEST_TOKEN`, `CHEST_TOOL`; in a test, deliver with `fakeChest().deliver`). |
| `schedules.handle` always answers 401 | The body was read before `handle`, or the environment is not the Chest's (in a test, deliver with `fakeChest().run`). |
| A schedule never runs | The route is not `POST /chest-schedules` at the root, the version was not approved, or its handler is missing (the tool's page says “the tool has no handler for this schedule (404)”). |
| No event ever comes | `chest.json` does not declare `"receives": ["member.*"]` (with `members`) or the tool event's type, the version was not approved, an admin switched the link off, the route is not `POST /chest-events` at the root, or — for a tool event — none of your members may see the item (its audience). |
| `ChestError` `invalid_data` from `emit` | A field not declared in `"emits"`, a required one missing or `null`, a value of another kind (text with a control or format character, a date that does not exist), or a member the tool never had. |
| `ChestError` `key_reused` from `emit` | The key went with other content within 72 hours: a key names one event; use another for another event. |
| `CapabilityNotGranted` from `emit` | The version declares no `"emits"`, or was not approved. |
| `ChestError` `erasure_not_found` from `acknowledgeErasure` | The erasure was not sent to this tool: acknowledge the `erasure` of the `member.erased` event you received. |
| `RateLimited` from `members` | More than 600 calls a minute: use `lookup` (200 ids a call, kept a minute) instead of one `get` per row. |
| `AiModelNotAllowed` from `ai` | The alias is not in `"ai": {"models"}` of `chest.json` (or is not one of `default`, `fast`, `smart`, `embedding`). |
| `AiUnavailable` with `no_connector` | The owner has not connected OpenRouter: a Chest setting, not a bug of the tool. |
| `AiCapReached` right after a deploy | The month's cap is spent, or `maxTokens` makes the worst case exceed what is left. |
| Build fails in the browser bundle | The SDK was imported from client code. |

## Contributing to this package

Keep it dependency-free (`node:*` only), with no network access other than the
Chest's API on `127.0.0.1`, and run `npm test` and `npm run check:package`
before opening a pull request.
