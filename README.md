# Chest SDK

`@argentic/chest-sdk` is what a server tool (tool contract 0.4) embeds to talk
with its Chest: the member the Chest asserts on a request, the Chest itself
(its organization, time zone, language and currency, and where the tool is
reached), the other members who have the tool, the address of the tool's own
database, its private files, the badges and notifications it shows members
inside the Chest, the events of its members' lifecycle, AI models through the
Chest — and, for the tool's tests, a fake Chest. It also publishes the tool
contract ([`contract/`](contract/README.md): what `chest.json` may say, what
the Chest builds, what migrations may do, the policies it adds) and `chest
check`, the Chest's own validator. The SDK has no dependency: it only
imports `node:*`.

```sh
npm install @argentic/chest-sdk
```

Node 22 or later. ESM only, compiled JavaScript with its type declarations.

## Imports

Each module is its own subpath and pulls in nothing else; the root gives them
all, with the files, members, notifications, events, schedules and ai APIs
as the namespaces `files`, `members`, `notifications`, `events`, `schedules`
and `ai` (the testing module is not in the root).

| Import | Gives |
|---|---|
| `@argentic/chest-sdk/member` | `member(request)`, type `Member`: the member of a request on the team host of a server tool, with the language the Chest speaks to them and the zone they work in, read from the `Chest-Member` assertion and verified; `null` without a valid assertion. `memberIdPattern`, `groupIdPattern`, `languagePattern`, `timeZonePattern`: the grammars of the identifiers (`mbr_…`, `grp_…`), of a language and of a zone |
| `@argentic/chest-sdk/chest` | `chest`, type `Chest`: the Chest the tool runs in — `chest.organization.name`, `chest.timeZone`, `chest.language`, `chest.currency`, `chest.today()` — and where the tool is reached — `chest.tool.teamUrl`, `chest.tool.publicUrl` —, the same for every member, on a request or outside one |
| `@argentic/chest-sdk/members` | `list`, `get`, `lookup`, `groups.list`, `forget`, types `MemberPage`, `Lookup`, `FormerMember`, `Group`: the members who have the tool (capability `members`, their addresses with `members.email`) |
| `@argentic/chest-sdk/notifications` | `notify`, `withdraw`, `badge.set`, `badge.setMany`, types `Notice`, `Delivery`, `BadgeCount`, `BadgeWrite`: counters on the tool's tile and items in members' inboxes, inside the Chest (capability `notifications`) |
| `@argentic/chest-sdk/events` | `handle`, `verify`, `acknowledgeErasure`, `memorySeen`, `erasureIdPattern`, types `ChestEvent`, `MemberUpdated`, `AccessRevoked`, `MemberRemoved`, `MemberErased`, `MemberChange`, `Handlers`, `Seen`: the events of the members' lifecycle the Chest posts to the tool's `/chest-events` (`"receives": ["member.*"]`), verified, deduplicated by id, and the acknowledgment of an erasure |
| `@argentic/chest-sdk/schedules` | `handle`, `verify`, types `Run`, `Handlers`, `Seen`: the runs of the tool's schedules (`"schedules"` in `chest.json`) the Chest posts to its `/chest-schedules` at their times, verified, deduplicated by id |
| `@argentic/chest-sdk/ai` | `chat`, `embed`, `models`, `usage`, types `Alias`, `Provider`, `ChatMessage`, `ChatTool`, `ToolChoice`, `ResponseFormat`, `ChatOptions`, `ChatResult`, `ChatChunk`, `ToolCall`, `ToolCallDelta`, `Usage`, `EmbedOptions`, `Embeddings`, `AiModel`, `AiUsage`: AI models through the Chest, on the owner's connectors, metered against the tool's monthly cap (capability `ai`) |
| `@argentic/chest-sdk/database` | `databaseUrl()`: the address of the tool's own PostgreSQL database (capability `database`) |
| `@argentic/chest-sdk/files` | `put`, `get`, `stat`, `list`, `move`, `delete`, `url`, `uploadUrl`, types `FileObject`, `FileData`, `FilePage`: the tool's private files (capability `files`), kept by the Chest, a 15-minute signed link to one (or to its thumbnail), and uploads straight from a member's browser |
| `@argentic/chest-sdk/errors` | `ChestError` (`code`, `status`), `CapabilityNotGranted` (403), `TooLarge` (413), `QuotaExceeded` (429), `RateLimited` (429), `Unavailable` (503), and for AI `AiCapReached` (402), `AiModelNotAllowed` (403), `AiRefused` (422), `AiUnavailable` (502, 503), type `AiUnavailableReason`: what the SDK throws when the Chest does not give what a tool asks |
| `@argentic/chest-sdk/testing` | `signAssertion`, `withMember`, `fakeChest`, types `AssertionOptions`, `FakeChest`, `FakeChestOptions`, `FakeGroup`, `FakeFile`, `FakeFormer`, `FakeNotification`, `FakeEvent`, `FakeRun`, `FakeAi`, `FakeAiModel`, `FakeAiReply`, `FakeAiCall`: for the tool's own tests only |
| `@argentic/chest-sdk` | all of the above but `testing`; `files`, `members`, `notifications`, `events`, `schedules` and `ai` as namespaces |

```ts
import { member } from "@argentic/chest-sdk/member";
import { chest } from "@argentic/chest-sdk/chest";
import { databaseUrl } from "@argentic/chest-sdk/database";
import * as files from "@argentic/chest-sdk/files";
import * as members from "@argentic/chest-sdk/members";
import * as notifications from "@argentic/chest-sdk/notifications";
import * as events from "@argentic/chest-sdk/events";
import * as ai from "@argentic/chest-sdk/ai";
import { CapabilityNotGranted } from "@argentic/chest-sdk/errors";
// or: import { member, chest, databaseUrl, files, members, notifications, events, ai } from "@argentic/chest-sdk";
```

`chest check`, the Chest's validator, is a separate development package,
`@argentic/chest-check`, not published yet (see [Check a tool](#check-a-tool--chest-check)):
this one stays a small runtime client.

Types refer to `node:http` (`IncomingMessage`): a TypeScript project needs
`@types/node`, as any Node project does. Both `moduleResolution` `bundler` and
`nodenext` work.

### Next.js

The SDK runs on the server only — it reads the tool's environment
(`CHEST_TOKEN`, `DATABASE_URL`, `CHEST_API`, `CHEST_TIME_ZONE`…) and uses Node built-ins. Import it
in route handlers, server components or server actions, never in a
`"use client"` module. Webpack and Turbopack resolve the
compiled package with no configuration (no `transpilePackages`):

```ts
// app/chest/api/me/route.ts
import { member } from "@argentic/chest-sdk/member";

export function GET(request: Request) {
  const who = member(request);
  return who ? Response.json(who) : new Response(null, { status: 401 });
}
```

## The contract, in short

A tool is an ordinary web server in a container without network, run by
its Chest. The Chest's front is the only one to reach it; the tool reaches only
what its launcher gives it on `127.0.0.1` (its database, the Chest's API for
its files, its members, its notifications and AI), and the Chest posts it the
events it receives on `/chest-events` and the runs of its schedules on
`/chest-schedules`, through the same launcher. Rights come
from the Chest — the signed member, the capabilities approved for the
version — and the Chest enforces them even outside the SDK:
the SDK makes the calls easier, it is not a security boundary. The contract
itself — every key of `chest.json` and its bounds, what the Chest builds,
what migrations may create, the Content-Security-Policy it adds, Next.js on
a Chest — is [`contract/README.md`](contract/README.md), rendered from the
Chest's own code.

## Check a tool — `chest check`

```sh
# once, in a clone of chest-by-argentic/Chest-SDK (not on npm yet)
npm ci                                   # builds check/ too
npx chest check /path/to/the/tool        # --json for agents and CI
# or, in the tool's repository, a local devDependency
npm install --save-dev /path/to/Chest-SDK/check
npx chest check
```

`@argentic/chest-check` is `check/` of this repository, not published on npm
yet: it runs from a clone.

The Chest's own validator — the code a Chest runs on every repository it
builds, compiled to WebAssembly (1.6 MB, in its own package, `check/` of
this repository, so that a tool's runtime dependencies stay small) — judges the repository as
the Chest would receive it: the files Git tracks or would add, as they are
now, committed or not. It says `OK` with the tool's name, roles, what it
asks and its migrations, or `Refused` with the Chest's reason (`manifest`,
`migrations`, `no_lock`, `newer_chest`…) and the rule broken; exit status 0,
1, or 2 when it could not run (not a Git repository). It reads nothing but
the archive it is given, and needs no network and no Chest. Details:
[`contract/README.md`](contract/README.md#check-a-repository).

`chest.json` names the version of the contract the tool is written for,
`"chest": "0.4"` — the MAJOR.MINOR of this SDK. A Chest older than that
refuses the tool with “This tool needs a newer version of your Chest”;
up to its own version, a key it does not know is refused, never ignored.

## `member(request)` — the member of a request

A tool is an ordinary web server; on its team host, the Chest relays
`/chest` and everything below it with the `Chest-Member` header of the
signed-in member. `member(request)` accepts a Node request (`IncomingMessage`)
or a Web `Request` and returns a `Member`, the type the `members` API
answers too:

```ts
type Member = {
  id: string;            // "mbr_…": the member in this Chest, the same in all its tools
  firstName: string;
  lastName: string;
  name: string;          // "Camille Martin", or the local part of the address without names
  photo: string | null;  // /_chest/members/{id}/photo?v=<rev> on the tool's team host
  role: string | null;   // one of the roles chest.json declares; null if it declares none
  isAdmin: boolean;      // owner or admin of the Chest
  isBuilder: boolean;    // builder of this tool
  groups: string[];      // "grp_…": the groups that give the member this tool
  language: string;      // "en", "fr"…: the language the Chest speaks to this member
  timeZone: string;      // "America/New_York": the zone the member works in
  email?: string;        // only with the capability "members.email"
};
```

or `null`: without the header, on the public host (the Chest never sends an
assertion there and strips a client's), or for any assertion that is not
exactly its own. Checks: compact JWS, header exactly
`{"alg":"HS256","typ":"JWT"}`, HMAC-SHA256 signature compared in constant time
under the key HMAC-SHA256("Chest-Member v2") of the text of `CHEST_TOKEN` —
the Chest's derivation; the label changes when a claim changes meaning or
goes, so an assertion of another shape is refused rather than misread, and
stays when a claim is added —, `aud` equal to
`CHEST_TOOL`, `iat` and `exp` within 5 s, the shape of each claim (`sub` an
`mbr_` identifier, `groups` `grp_` identifiers, `language` a primary tag of
2 or 3 lowercase letters, `time_zone` a zone of `timeZonePattern`; an
unknown claim is ignored). Without
`CHEST_TOKEN` or `CHEST_TOOL`, nobody is a member. The function never throws
for what a request carries.

```ts
import { member } from "@argentic/chest-sdk/member";
const who = member(request);
if (!who) { response.writeHead(401).end(); return; }
```

`id` is the member's identifier in the Chest: random, never an address nor
an account of the sign-in provider, stable when the member changes their name
or address, never given to anyone else. Store it in your data; resolve names
when rendering (`members.lookup`). `photo` is served by the Chest on the team
host to members who have the tool; `role` is the one the Chest gives the
member among those the manifest declares. Only the Chest's front reaches the
container: the signature is a second defence; business rules (who writes
what) remain the tool's.

`language` is the member's own language in the Chest, else the Chest's
default: a BCP 47 primary tag among those the product speaks (`en`, `fr`
today; the SDK accepts any, so a language added to the Chest needs no new
SDK). The tool's private part (`/chest`) speaks it — to this member, on every
request — and offers no language switch of its own; only its public parts,
where nobody is signed in, keep their own switch. The members API answers
it too: a notification or an email to another member is written in *their*
language (`members.get(id).language`), not in the sender's. A tool that does not
speak that language uses its own default. `timeZone` is the zone the member
works in: the one they chose in their profile, else the one their browser
is in, else the Chest's. The members API answers it too, so a tool reminds
each member at their own hour. What is the same for every member — the
organization, the company's time zone — is not the member's: it is the
Chest's (below).

### Times: store in UTC, decide in the Chest's zone, show in the member's

| What | Zone |
|---|---|
| An instant (created, due at, sent at) | stored as UTC: `timestamptz` in PostgreSQL, `Date` in code |
| “Today”, “this week”, a deadline's day, business hours, working days | the company's: `chest.timeZone`, `chest.today()` (the database's `current_date` is the same) |
| A time or a date shown to a member, a personal reminder's hour | theirs: `member(request).timeZone`, or `members.get(id).timeZone` outside their request |

```ts
const who = member(request)!;
const due = await sql`select * from tasks where due_on = ${chest.today()}`; // the company's day
const shown = new Intl.DateTimeFormat(who.language, { timeZone: who.timeZone, dateStyle: "medium", timeStyle: "short" }).format(task.remindAt);
```

## `chest` — the Chest the tool runs in

```ts
import { chest } from "@argentic/chest-sdk/chest";

chest.organization.name; // "Acme SAS": the organization the Chest is of, as its owner wrote it
chest.timeZone;          // "Europe/Paris": an IANA zone, "UTC" until the owner sets one
chest.language;          // "fr": the Chest's own language (a member's is member(request).language)
chest.currency;          // "EUR": the Chest's currency, ISO 4217
chest.tool.teamUrl;      // "https://tasks-chest.acme.argentic.work": where members open /chest
chest.tool.publicUrl;    // "https://status.acme.com": the public part (its custom domain), or null
chest.today();           // "2026-09-30": the date now in the Chest's zone (or chest.today(at))
```

The Chest gives these to every tool in its environment at each start
(`CHEST_ORGANIZATION`, `CHEST_TIME_ZONE`, `CHEST_LANGUAGE`, `CHEST_CURRENCY`,
`CHEST_TEAM_URL`, `CHEST_PUBLIC_URL`), and starts every tool that is awake
again when one changes — the owner changes the first four in Settings →
General; a custom domain served, or no longer, changes the public address —;
a tool asleep reads them when it wakes. The tool never asks its own admin for
the company's name, zone or currency, nor guesses its own address from a
request. They are there outside a
request too: a scheduled job, a start-up task, an export. No capability is
needed: nothing here is more than what the Chest's pages show its members.

- `organization.name` is plain text of 2 to 80 characters: show it in a
  header, a document or an email, never as HTML.
- `timeZone` is the day of “due today” and the hour of a reminder. The Chest
  also makes it the `TimeZone` of the tool's database sessions: there,
  `current_date`, `now()::date` and a `timestamptz` shown as text are in the
  Chest's zone. A session may set its own (`SET TIME ZONE`), for itself.
- `language` is the language of what the tool writes for no one in
  particular: a public page before the visitor chooses, an export's default.
  A page of `/chest` speaks `member(request).language` instead.
- `currency` is the ISO 4217 code of the Chest's currency (`"EUR"` until
  the owner sets one): the amounts of a quote, a price, an expense. Format
  them with `Intl.NumberFormat(language, { style: "currency", currency:
  chest.currency })`.
- `tool.teamUrl` and `tool.publicUrl` are origins, without a path: build a
  link where no request tells the host — an email sent from a scheduled job,
  a calendar feed — with `new URL("/chest/tasks/42", chest.tool.teamUrl)`.
  `publicUrl` is the company's own domain once the owner connected one, else
  the tool's public host; `null` for a tool without a public part. Store
  paths in your data, never these origins: they change.
- `today(at?)` is `YYYY-MM-DD` in the Chest's zone, for now or for an instant
  (`Date` or milliseconds): compare it with dates your database keeps as
  `date`, never with `new Date().toISOString().slice(0, 10)`, which is UTC's.

Each value is read from the environment at each access, and checked: outside a
Chest (a development server without the variables), or for a value the Chest
never gives, reading it throws a `ChestError` with the code `not_in_chest` —
a wrong zone read silently is exactly what this module exists to prevent. In
tests, `fakeChest({chest: {organization, timeZone, language, currency,
teamUrl, publicUrl}})` sets them.

## `members` — who has the tool

A tool that declares `"capabilities": ["members"]` (approved like a
permission: “Sees the name, photo, role and groups of the members who have
access to it.”) reads the members who have it, through the Chest's API
(`CHEST_API`, as for files). `"members.email"`, a permission of its own that
requires `members`, adds their addresses — to these answers and to
`member(request)`.

```ts
import * as members from "@argentic/chest-sdk/members";
const { members: page, next } = await members.list({ q: "cam", limit: 50 }); // by name, then id
const camille = await members.get("mbr_k2qhx4mzc7v3b6nfp5r2t7w4ya");        // Member, or null
const { members: found, former, unknown } = await members.lookup(ids);      // any number of ids
const teams = await members.groups.list();                                  // [{id, name, members}]
```

- **Who**: exactly the members who have the tool now — by a grant, a group,
  open to all, or because they run it (owner, admins, its builders);
  recomputed at every call. `list` and `get` see only them (`get` → `null`
  for anyone else); `lookup` also names those the tool had who no longer
  have it (below).
- **`list({after, limit, q, role, group})`**: ordered by name (accents aside)
  then identifier; `limit` 100 by default, 500 at most; `next` is an opaque
  cursor for `after`, `null` after the last page. `q` finds the start of a
  first name, a last name or a name — and of an address with `members.email`
  —, whatever its case and accents; `role` and `group` keep the members of that
  role or group.
- **`lookup(ids)`**: each identifier once, in the order given: `members`,
  `former` — those the tool had who no longer have it: `{id, name, status:
  "no_access"}`, a member of the Chest who lost access to the tool (“Léa
  Dubois (no access)”: the laptops she holds, the goals that need a new
  owner); `{id, name, status: "former"}`, someone who left the Chest, so a
  record still reads “Camille Martin (former member)”; `{id, name: null,
  status: "erased"}` once the owner had their data erased, rendered “Former
  member” — and `unknown`: an identifier the tool never had (the Chest names
  nobody the tool never had, not even a member of the Chest). The SDK asks 200 at a time and
  keeps each answer a minute in the process (5,000 at most); `forget()`
  empties it, and so does every event of the members' lifecycle
  (`events.handle`).
- **`groups.list()`**: the groups that give the tool, with their members'
  identifiers; never the others.
- Errors: `CapabilityNotGranted` (403), `RateLimited` (429: 600 calls a minute
  per instance), `Unavailable` (503), `ChestError` for the rest (`invalid_id`,
  `invalid_query`).

Store identifiers, resolve names when rendering, never copy them: a copied
name or address goes stale and makes the tool a second directory to erase.

```sql
create table tasks (
  id bigint generated always as identity primary key,
  title text not null,
  assignee text,                                     -- a member id, "mbr_…"
  created_by text not null,
  constraint assignee_is_member check (assignee ~ '^mbr_[a-z2-7]{26}$')
);
```

```ts
const rows = await sql`select * from tasks order by id desc limit 50`;
const people = await members.lookup(rows.flatMap(r => [r.assignee, r.created_by]).filter(Boolean));
```

To search tasks by assignee name: `members.list({ q })` first, then
`where assignee = any($ids)`.

## `notifications` — badges and inbox items

A tool that declares `"capabilities": ["notifications"]` (approved like a
permission: “Shows counters and sends notifications, inside the Chest, to the
members who have access to it.”) tells its members what needs their
attention, inside the Chest only — no email, no push to a phone. Two
primitives:

- a **badge** is a count on the tool's tile in the Chest home and on its row
  in the tools list, for one member (“99+” beyond 99): a state, set again as
  often as it changes;
- a **notification** is an item in a member's inbox (the bell of the Chest):
  the tool's icon and name, a title, a body, and a link that opens a page of
  the tool on its team host.

```ts
import * as notifications from "@argentic/chest-sdk/notifications";

const { delivered, skipped } = await notifications.notify([assignee], {
  title: "New task: fix the door",       // 1 to 80 characters
  body: "Before Friday.\nKeys at the desk.", // 280 characters at most; optional
  path: "/chest/tasks/42",               // under /chest; /chest when not said
  key: "task:42",                        // optional: replace, then withdraw
});
await notifications.withdraw("task:42");             // done: its items go, for everyone
await notifications.withdraw("task:42", [assignee]); // only for those
const shown = await notifications.badge.set(assignee, 3);            // false: no access
const { set, skipped: noAccess } = await notifications.badge.setMany([
  { memberId: assignee, count: 3 },
  { memberId: reviewer, count: 0 },    // 0 clears it
]);
```

- **Who**: only members who have access to the tool now receive either.
  `notify` answers `{delivered, skipped}`, each identifier once in the order
  given; `skipped` holds identifiers the Chest does not know and members
  without access (as for `members`, the two are indistinguishable). `badge.set`
  answers `false` for such a member, `setMany` puts them in `skipped`.
- **`notify(memberIds, {title, body?, path?, key?})`**: 1 to 500 identifiers
  (a duplicate counts once), one inbox item per recipient. `title` is 1 to 80
  characters (Unicode code points), `body` 280 at most (an empty body is
  none). `path` is a page of the tool's private part: `/chest`, or `/chest`
  followed by `/`, `?` or `#`; printable ASCII without spaces or `\`, 512
  characters at most, never `//`, no `.` or `..` segment; the Chest builds the
  link on the tool's team host, so it cannot point anywhere else. `key` is
  1 to 64 of `a-z 0-9 . _ : -`.
- **Replace and withdraw.** A notification with the key of an earlier one, for
  the same member, replaces it: new text, new time, first in the inbox and
  unread again — never a duplicate. `withdraw(key, memberIds?)` removes the
  items of that key, from every member or from those named (1 to 500), once
  the thing they were about is done. It never says what existed.
- **Plain text.** The Chest removes control characters (a tab or a line break
  in a title becomes a space; `body` keeps its line breaks) and the characters
  that reorder text, trims both, and interprets neither Markdown nor HTML.
  Every item shows the tool's icon and name beside it: a tool cannot pass for
  the Chest or another tool. A title that is empty once cleaned is refused.
- **Muting is invisible.** A member may mute the tool in their profile: their
  new items are then dropped, but they still count as `delivered`, and their
  badges stay. The tool never learns who muted it.
- **Badges** go from 0 to 9,999, 0 clears one. `setMany` takes 1 to 500, a
  member at most once.
- **Quotas**, per tool: 1,000 recipients an hour (those with access, muted or
  not), 100 items per member a day (a replacement counts; one recipient at 100
  refuses the whole call), 600 badge writes a minute (each badge of `setMany`
  counts). Beyond, `QuotaExceeded` (429, the Chest answers `Retry-After`); a
  refused call changes nothing.
- **Lifecycle**: a member who loses access loses the tool's items and badge;
  removing the tool removes them all. A member's inbox keeps 500 items for 90
  days.
- Errors: `CapabilityNotGranted` (403), `QuotaExceeded` (429), `Unavailable`
  (503, the Chest not reached, or an answer that is not its own: the call may
  or may not have happened), `ChestError` for the rest (`invalid_id`,
  `invalid_title`, `invalid_text`, `invalid_path`, `invalid_key`,
  `invalid_count`, `invalid_body`) — the SDK refuses these before sending
  anything.

A badge suits a count that goes up and down (tasks assigned, messages
unread); a notification, an event worth a look — with a key, so that it goes
away by itself once handled.

## `events` — the members' lifecycle

A tool that holds `members` and declares `"receives": ["member.*"]` in its
`chest.json` (approved like a permission: “Is told when the members who have
access to it change or leave.”) is told, on its own `POST /chest-events`:

| Event | `data` | When |
|---|---|---|
| `member.updated` | `{id, changed: ("name" \| "photo" \| "role" \| "groups" \| "email" \| "language" \| "timeZone")[]}` | Something the tool sees of a member who has it changed (`email` only with `members.email`; `language` and `timeZone`: the language the Chest speaks to them and the zone they work in — a digest's words and hour) |
| `access.revoked` | `{id}` | The member lost access to the tool but stays in the Chest |
| `member.removed` | `{id}` | The member left the Chest: `lookup` now reads them `former` |
| `member.erased` | `{id, erasure, deadline}` | The owner asked for this person's data to be erased: delete or anonymise what the tool keeps of them before `deadline` (30 days), then `acknowledgeErasure(erasure)` |

A member who gets the tool is no event: the next `list` has them.

```jsonc
// chest.json
{ "capabilities": ["members"], "receives": ["member.*"] }
```

```ts
// app/chest-events/route.ts — at the root, outside /chest: the Chest calls it
// through the tool's launcher, never from a browser (its front answers 404 there).
import * as events from "@argentic/chest-sdk/events";

const seen = {
  has: async (id: string) => (await sql`select 1 from chest_events where id = ${id}`).length > 0,
  add: async (id: string) => { await sql`insert into chest_events (id) values (${id}) on conflict do nothing`; },
};

export async function POST(request: Request) {
  return new Response(null, { status: await events.handle(request, {
    "member.updated": e => refreshCache(e.data.id, e.data.changed),
    "access.revoked": e => sql`update tasks set assignee = null where assignee = ${e.data.id}`,
    "member.erased": async e => {
      await sql`update tasks set created_by = 'erased' where created_by = ${e.data.id}`;
      await events.acknowledgeErasure(e.data.erasure);
    },
  }, { seen }) });
}
```

- **Delivery**: at least once, in no guaranteed order. An event is an
  envelope `{id: "evt_…", type, occurredAt, data}`, signed for this tool
  (`Chest-Event` header, HS256 under a key derived from `CHEST_TOKEN` with
  the label `Chest-Event v1`, naming the event and the SHA-256 of the body,
  60 seconds). Any answer but a 2xx is delivered again, the same event with
  the same id, after 5 s, 15 s, 30 s, 1 min, 2 min, 5 min, 10 min, 30 min, then
  every hour, for 72 hours — a restart of the node included. Given up, the
  tool is marked “out of sync” on its page until its next start.
- **`members.list` is the truth.** Reconcile by listing at start (and so after
  being out of sync): events keep a tool current between starts, they do not
  replace reading who has it.
- **`handle(request, handlers, {seen?})`** answers the status to give the
  Chest: 401 for what is not a delivery of the Chest for this tool, 204 for an
  event handled, one already in `seen`, a type without a handler, or one of a
  later Chest (signed, ignored). It reads the body (64 KiB at most): mount it
  before any body parser. A handler that throws leaves the event unseen and
  `handle` throws: answer 500, it comes again. `seen` is the store of the
  handled ids — `memorySeen()` (the default: 10,000 ids in the process, lost
  at a restart) or a table of the tool's own, as above. Make handlers
  idempotent anyway: an event handled but not yet added to `seen` when the
  tool stops comes again.
- **`verify(request)`** is the event of a delivery, typed, or `null`; for a
  tool that routes events itself.
- **`acknowledgeErasure(erasure)`**: `POST /erasures/{erasure}/done` on the
  Chest's API; the owner then sees the tool's part done (“Erased on 3 Oct.”),
  “Overdue” past the deadline otherwise. Again is harmless. Errors:
  `ChestError` `erasure_not_found` (404: an erasure this tool was not told of)
  or `invalid_id` (400), `CapabilityNotGranted` (403), `Unavailable`.

## `ai` — AI models through the Chest

A tool that declares the `ai` capability calls AI models through its
Chest. The Chest's owner connects OpenRouter with the company's own key;
the tool calls models by four **aliases**: `default`, `fast`, `smart`,
`embedding`, each led by the Chest to a model it chose (the owner may choose
another for `default`). The tool names an alias, never a provider's model:
the model changes for the whole Chest without touching code. The tool never
holds a key; the Chest meters every call against the tool's monthly cap.

```jsonc
// chest.json
{
  "capabilities": ["ai"],
  "ai": { "monthly": 20, "models": ["default", "embedding"], "purpose": "Summarises support tickets" }
}
```

| Key | Default | |
|---|---|---|
| `monthly` | 5 | Whole euros a month, 1 to 1,000: what the tool asks; the owner's cap replaces it and may be changed at any time |
| `models` | `["default"]` | 1 to 4 of `default`, `fast`, `smart`, `embedding`: the only aliases the tool may call |
| `purpose` | required | 1 to 120 characters, shown at approval: “Uses AI models through the Chest, up to €20 a month” |

```ts
import * as ai from "@argentic/chest-sdk/ai";

const r = await ai.chat({
  model: "default",
  messages: [{ role: "system", content: "Summarise in two sentences." }, { role: "user", content: ticket.text }],
  maxTokens: 300,                 // 1 to 128,000; 4,096 when not said
  member: who.id,                 // optional: attribution in the Chest's usage log
});
r.text;                           // "" when the model only called tools
r.usage;                          // { input, output, cached, cost } — cost in estimated euros

// Streamed: pieces as they come; breaking out of the loop ends the call.
for await (const chunk of ai.chat({ model: "fast", messages, stream: true, signal })) {
  write(chunk.text);              // chunk.toolCalls, chunk.finishReason, then chunk.usage last
}

// Tools: the model asks, the tool runs them and answers.
const step = await ai.chat({ model: "smart", messages, tools: [{ type: "function", function: { name: "lookup", parameters: schema } }] });
messages.push(step.message);
for (const call of step.toolCalls) messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(await run(call.name, JSON.parse(call.arguments))) });

const { embeddings } = await ai.embed({ model: "embedding", input: ["first text", "second text"] }); // 1 to 256 texts
const mapped = await ai.models();  // [{ alias, model, provider, input, output }] — USD per million tokens
const month = await ai.usage();    // { month: "2026-09", spent, cap, resetsAt }
```

- **`chat(options)`** takes the OpenAI Chat Completions request in camelCase:
  `model`, `messages`, `maxTokens`, `temperature`, `topP`, `stop`, `tools`,
  `toolChoice`, `responseFormat`, `parallelToolCalls`, `seed`,
  `reasoningEffort`, plus `member`, `stream` and `signal`. Messages, tools and
  response formats keep the OpenAI shape (images in `content` parts too); the
  Chest translates them for each provider and never runs a tool. Without
  `stream` it returns `Promise<ChatResult>` `{text, message, toolCalls,
  finishReason, model, usage}` — `message` is the assistant's message to add
  to the conversation, `toolCalls` are `{id, name, arguments}` with the
  arguments as JSON text, `model` is the provider's model. With
  `stream: true` it returns an `AsyncIterable<ChatChunk>` `{text, toolCalls?,
  finishReason?, usage?}`: tool calls come in pieces (`{index, id?, name?,
  arguments?}`: join the `arguments` of the same `index`), the usage in the
  last chunk.
- **Bounds**: a request body of 10 MiB (images included), 16 MiB of answer, a
  call ends after 10 minutes (streamed or not); 60 requests a minute and 8
  streams at once per tool (`RateLimited`). An aborted `signal` throws its
  reason.
- **The cap never overshoots**: before a call the Chest reserves its worst
  case (input and `maxTokens`) against the tool's cap and the Chest's; a call
  that does not fit is refused before anything is spent. Keep `maxTokens` to
  what the answer needs.
- **`embed({model, input, dimensions?, member?})`** gives one vector per text,
  in the order given, and the input tokens and cost.
- **`models()`** gives the aliases the tool declared that the owner mapped,
  with their model, provider and prices; **`usage()`** the tool's month:
  estimated euros spent, the cap in force, and when the month resets.

**AI can stop at any time** — the month's budget spent, no connector, the
provider down. Keep the tool usable without it:

```ts
import { AiCapReached, AiUnavailable } from "@argentic/chest-sdk/errors";

let summary: string | null = null;
try {
  summary = (await ai.chat({ model: "default", messages, maxTokens: 300 })).text;
} catch (error) {
  if (!(error instanceof AiCapReached || error instanceof AiUnavailable)) throw error;
  // summary stays null: show "AI features are paused" and keep the page working
}
```

| Error | Code, status | When |
|---|---|---|
| `AiCapReached` | `cap_reached` 402 | The tool's (`scope: "tool"`) or the Chest's (`scope: "chest"`) monthly cap is spent, until `resetsAt` |
| `AiUnavailable` | `no_connector` 503, `provider_key_invalid` 502, `provider_unavailable` 503 | No connector behind the alias, the provider refused the connector's key, or failed (`reason`) |
| `AiModelNotAllowed` | `model_not_allowed` 403 | An alias the tool did not declare in `models` (the SDK refuses any other name before sending) |
| `CapabilityNotGranted` | `capability_not_granted` 403 | The version does not hold `ai`, or it was not approved |
| `AiRefused` | `content_refused` 422 | The provider's moderation refused the content |
| `RateLimited` | `rate_limited` 429 | 60 requests a minute or 8 streams at once |
| `TooLarge` | `too_large` 413 | A body beyond 10 MiB, or a context beyond the model's |
| `ChestError` | `invalid_body`, `invalid_request` 400 | A malformed request (the SDK refuses most before sending), or parameters the provider rejected (its message in the error's) |
| `Unavailable` | `unavailable` 503 | The Chest not reached, or an answer that is not its own; in a stream, the stream cut |

An error in the middle of a stream is thrown where it comes, after the chunks
before it.

## `databaseUrl()` — database of a server tool

A tool that declares `"capabilities": ["database"]` in its `chest.json`
gets a PostgreSQL database of its own (the capability is shown and approved
like a permission, in the approval screen). The container has no network: its
launcher listens on `127.0.0.1` and relays each connection to the Chest. The
launcher sets `DATABASE_URL` —
`postgres://<user>:<password>@127.0.0.1:<port>/<database>?sslmode=disable`,
the user and the database both named `t_<tool>`, or `pb_<project>` in the
preview of a draft Perseus Code builds — and `PGHOST`, `PGPORT`,
`PGUSER`, `PGPASSWORD`, `PGDATABASE`, which take precedence over a variable of
the tool with the same name. `databaseUrl()` returns `DATABASE_URL` when it has
exactly this shape, and throws `CapabilityNotGranted` otherwise (a version
without the capability, or a `DATABASE_URL` of the tool's own). The value is a
secret: never log it, never send it to a browser.

The SDK carries no PostgreSQL client: the tool picks its own, for example
[`postgres`](https://github.com/porsager/postgres) (porsager, no dependency) or
[`pg`](https://node-postgres.com):

```ts
import postgres from "postgres";
import { databaseUrl } from "@argentic/chest-sdk/database";
const sql = postgres(databaseUrl(), { max: 5 });
const notes = await sql`SELECT id, text FROM notes ORDER BY id`;
```

Ten connections at most per instance; a query longer than 30 s, a transaction
idle longer than 60 s are interrupted by the Chest. **Migrations**: the
repository's `migrations/NNNN_name.sql` files
(`^[0-9]{4}_[a-z0-9_-]{1,64}\.sql$`, 256 at most, 1 MiB each) are run by the
Chest, in order, each in its own transaction, at install and at every update,
before the new version receives traffic; a failing file keeps the version in
service. The Chest keeps the list of files run (table `chest_migrations`): a
version that loses one or changes one is refused. A migration must leave the
previous version working — going back to the previous version undoes nothing.

## `files` — files of a server tool

A tool that declares `"capabilities": ["files"]` (approved like a permission)
keeps private files **through its Chest**, never on its disk (the container's
root is read-only). The launcher gives the tool
`CHEST_API=http://127.0.0.1:<port>` — its own port, relayed to the Chest; the
container has no network — and the instance is the identity: the tool reaches
its own files only.

```ts
import * as files from "@argentic/chest-sdk/files";
await files.put("photos/cat.png", bytes, "image/png");       // Uint8Array or text
const file = await files.get("photos/cat.png");              // {data, type, size} or null
const info = await files.stat("photos/cat.png");             // {name, type, size, sha256, updated, width?, height?} or null
const { files: page, next } = await files.list({ prefix: "photos/" }); // 1000 per page
await files.move("photos/cat.png", "archive/cat.png");       // atomic; replaces archive/cat.png
await files.delete("archive/cat.png");                       // true, or false if it did not exist
const { url, expiresIn } = await files.url("photos/dog.png", { thumbnail: 256 });
```

A name: up to 8 segments of 1 to 100 letters, digits, `.`, `_` or `-`,
separated by `/`, none starting with `.` or `-`; refused before anything is
sent otherwise (`ChestError`, `invalid_name`).

### Limits

Per tool: 1 GiB, 10,000 objects and 32 MiB per object, unless its manifest
asks otherwise — approved by the owner like any permission, and a later
version that asks more is approved again:

```jsonc
// chest.json
{ "capabilities": ["files"], "files": { "quota": "5 GiB", "maxObject": "100 MiB" } }
```

`quota` goes from 100 MiB to 100 GiB (10 GiB and more allow 100,000 objects),
`maxObject` from 1 to 512 MiB; the owner or an admin may also set the quota
by hand. The SDK refuses beyond 512 MiB before sending anything; the Chest
holds the tool to its own bounds (`TooLarge`, `QuotaExceeded`). `put` and
`get` carry the bytes through the tool's server: for large files, let the
browser upload them itself.

### Uploads from a member's browser

The bytes go from the browser to the Chest directly, never through the tool.
The tool authorises one upload, in a `/chest` route, once `member()` said who
asks:

```ts
// Server side: app/chest/api/invoices/upload/route.ts
const up = await files.uploadUrl("invoices/2026/0042.pdf", {
  maxSize: 10 << 20,                // bytes; the tool's largest object when not said
  types: ["application/pdf"],       // up to 8, "image/*" for a family; any when not said
  expiresIn: 300,                   // 1 to 900 seconds; 900 when not said
});
// → { url, method: "PUT", expiresIn }: hand it to the member's browser
```

```ts
// Browser side, on a page under /chest: the member's session goes with it
const response = await fetch(up.url, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
// 201 {name, type, size}; 403 invalid_token (used, expired), 415 type_refused,
// 400 type_mismatch, 413 too_large, 429 quota_exceeded, 401 without a session
```

```ts
// Server side, when the browser says it is done
const info = await files.stat("invoices/2026/0042.pdf"); // null if nothing came
```

`url` is `https://<tool's team host>/_chest/files/upload/<token>`: the same
origin as the tool's `/chest` pages, so no CORS. The token is signed by the
Chest and binds the name, the size, the types and the expiry; it serves once.
A name ending in `/` is a folder: the Chest then names the object (20 hex
characters and an extension from its type) and answers its name. The Chest
checks the declared size before reading, drops the body at the first byte too
many, and for images, PDFs and archives checks that the first bytes are of the
type sent; nothing of a refused upload remains. There is no antivirus scan.
`uploadUrl` answers `Unavailable` while the Chest does not know the tool's
team host yet.

### Links and thumbnails

`url(name, {thumbnail?, download?})` signs a link to the file as it is, on the
tool's **team host** (`/_chest/files/…`): whoever has it opens it without
signing in for 15 minutes, or until the file changes or goes; the Chest serves
it in a sandbox, displayed for an image, a PDF or plain text, downloaded
otherwise, or always downloaded with `download: true`. `thumbnail: 256` or
`1024` links to the image reduced to that many pixels (JPEG, PNG, GIF — its
first frame — and WebP up to 40 megapixels; `ChestError` `no_thumbnail`
otherwise); thumbnails are made once, not counted in the quota. `stat` gives
`width` and `height` for these images. Give a link to a member's browser,
never to a public page.

Every file the Chest answers (`put`, `stat`, `list`, `move`) carries
`sha256`, the digest of its content in hex, as the Chest took it: compare
it, or detect a duplicate receipt, without reading the file again.

The SDK takes a link or an upload address from the Chest only in `https`
on the team host, or on the origin of the Chest's API itself (`CHEST_API`,
`http://127.0.0.1:<port>`): the address the tool already sends every call
to, where only a fake Chest (`@argentic/chest-sdk/testing`) serves its
links. A real Chest never answers one there, and no other local address is
ever taken — so a tool a test starts in its own process (`next start` with
the fake's environment) takes the fake's links as the test itself does.

Errors: `CapabilityNotGranted` (a version without the capability, or no
`CHEST_API`), `TooLarge` (413), `QuotaExceeded` (429), `Unavailable` (the
Chest not reached, or an answer that is not its own: a write may or may not
have happened), `ChestError` for the rest (`invalid_type`, `no_thumbnail`,
`not_found` for `url` and `move`…). Removing the tool removes its files; a new
version keeps them.

## `schedules` — work the tool does by itself

Nothing runs in a tool's container between requests — the Chest puts a tool
nobody uses to sleep —: a morning digest, reminders, a purge or a badge kept
true overnight come from the Chest, which calls the tool at set times. The
tool declares each schedule in its `chest.json`, a name and a cron line read
on the wall clock of the Chest's time zone (`chest.timeZone`), approved in
words (“Runs by itself: morning, weekdays at 7:30 AM”):

```jsonc
// chest.json
{ "schedules": [{ "name": "morning", "cron": "30 7 * * 1-5" }, { "name": "retry-mail", "cron": "*/15 * * * *" }] }
```

```ts
// app/chest-schedules/route.ts — at the root, outside /chest: the Chest calls
// it through the tool's launcher, never from a browser (its front answers 404 there).
import * as schedules from "@argentic/chest-sdk/schedules";
import { chest } from "@argentic/chest-sdk/chest";

export async function POST(request: Request) {
  return new Response(null, { status: await schedules.handle(request, {
    morning: async () => { await sendDigest(chest.today()); },
    "retry-mail": () => retryOutbox(),
  }, { seen }) });
}
```

- **The line**: five fields — minute, hour, day of the month, month, day of
  the week —, each numbers, `*`, ranges (`1-5`), lists (`1,15`) and steps
  (`*/15`); Sunday is 0 or 7; no names nor `@daily`, one space between
  fields. When both days are restricted, either one runs (as cron). A time
  a change of clock skips runs once, shifted; a repeated one runs once.
- **Bounds** (the Chest's, checked when the manifest is read): 8 schedules,
  names of 1 to 32 lowercase letters, digits and hyphens, each running 15
  minutes apart at least; 5 minutes a run.
- **Approval**: running by itself is a permission, one sentence per
  schedule. A later version that changes, adds or removes schedules of a
  tool that already had one asks nothing more.
- **Delivery**: `POST /chest-schedules`, the tool woken first when it
  sleeps, body `{id: "run_…", name, scheduledAt, attempt}` signed for this
  tool (`Chest-Schedule` header, HS256 under a key derived from
  `CHEST_TOKEN` with the label `Chest-Schedule v1` — the scheme of events,
  under a key of its own —, naming the run and the SHA-256 of the body, 60
  seconds). `scheduledAt` is the time the run stands for (UTC); a run asked
  now stands for the time it was asked.
- **Answer once the work is done**, within 5 minutes: a 2xx is done; a 404
  (a schedule without a handler) is given up at once; anything else, or no
  answer, is delivered again, the same run with the same id, after 1, 5 and
  15 minutes (`attempt` 2 to 4), unless the next time of its schedule comes
  first. Runs of one schedule never overlap: a time that comes while the
  previous run still runs is skipped. A server that was stopped runs a
  missed time once when it starts again — the latest, never a backlog.
  Longer work: do a batch per run and keep your place in the database.
- **`handle(request, handlers, {seen?})`** answers the status to give the
  Chest: 401 for what is not a run of the Chest for this tool, 404 for a
  schedule without a handler, 204 for a run handled or one already in
  `seen`. It reads the body (1 KiB at most): mount it before any body
  parser. A handler that throws leaves the run unseen and `handle` throws:
  answer 500, it comes again. `seen` is as for `events` (`events.memorySeen`
  by default; a table of the tool's for runs that must never be done twice —
  the same table serves both, the ids never meet). Make handlers idempotent
  anyway.
- **`verify(request)`** is the run of a delivery, or `null`; for a tool that
  routes runs itself.
- **The Chest's times, the members' zones**: a line is the company's clock.
  To reach each member at *their* 8:00, run hourly (`0 * * * *`) and pick
  the members whose local hour it is (`members.list`, `member.timeZone`).
- **Whoever runs the tool** sees each schedule on its overview — when it
  runs next, its last runs and why one failed — and may **Run now**; an
  agent reads `GET /api/v1/tools/<tool>/schedules` and runs one with
  `POST /api/v1/tools/<tool>/schedules/run {name}` (a token that writes).

## `testing` — a tool's own tests

`@argentic/chest-sdk/testing` is for tests, never imported by production code.

```ts
import { fakeChest, signAssertion, withMember } from "@argentic/chest-sdk/testing";

const camille = { id: "mbr_k2qhx4mzc7v3b6nfp5r2t7w4ya", firstName: "Camille", lastName: "Martin", name: "Camille Martin", photo: null, role: "editor", isAdmin: false, isBuilder: false, groups: [], language: "fr", timeZone: "Europe/Paris" };
const chest = await fakeChest({ members: [camille], capabilities: ["members", "files", "notifications", "ai"], ai: { reply: () => "Summary." } });
const response = await handler(withMember(new Request("http://tool.test/chest/tasks"), camille));
assert.equal(await chest.emit({ type: "member.erased", data: { id: camille.id, erasure: "era_k2qhx4mzc7v3b6nfp5r2t7w4ya", deadline: "2026-10-28T10:00:00Z" } }, request => handler(request)), 204);
assert.deepEqual(chest.acknowledged, ["era_k2qhx4mzc7v3b6nfp5r2t7w4ya"]);
assert.deepEqual((await members.list()).members.map(m => m.id), [camille.id]);
assert.ok(chest.files.has("reports/2026.pdf"));
assert.deepEqual(chest.notifications, [{ member: camille.id, title: "New task", path: "/chest/tasks/42", key: "task:42" }]);
assert.equal(chest.badges.get(camille.id), 1);
assert.equal(chest.ai[0]?.path, "/ai/chat");
assert.equal(await chest.run("morning", request => handler(request)), 204);
await chest.close();
```

| Function | Gives |
|---|---|
| `signAssertion(member, {token?, tool?, now?})` | A `Chest-Member` header value signed like the Chest's for that `Member` (the token and tool of the environment by default), signed as given, so a language or a zone the Chest never sends makes `member()` refuse it |
| `withMember(request, member, options?)` | The request carrying that assertion (the options of `signAssertion`): a new Web `Request`, or the same Node request |
| `fakeChest({members?, former?, groups?, capabilities?, receives?, files?, ai?, chest?})` | An HTTP server on `127.0.0.1` that sets `CHEST_API`, `CHEST_TOKEN`, `CHEST_TOOL` (`tool` unless set), the Chest's `CHEST_ORGANIZATION`, `CHEST_TIME_ZONE`, `CHEST_LANGUAGE`, `CHEST_CURRENCY`, `CHEST_TEAM_URL`, `CHEST_PUBLIC_URL` (`chest: {organization, timeZone, language, currency, teamUrl, publicUrl}`: `"Test organization"`, `"UTC"`, `"en"`, `"EUR"`, `https://<tool>-chest.chest.test`, `https://<tool>.chest.test` by default; `publicUrl: null` for a tool without a public part) and answers members, groups, files, badges, notifications, AI and erasure acknowledgments with a Chest's bounds, quotas and errors; a capability left out answers 403 (`members`, `files`, `notifications` and `ai` by default; `members.email` adds the addresses; `receives` is `["member.*"]` by default, `[]` refuses acknowledgments). `former: [{id, name?, status?}]` are those the tool had who no longer have it: `lookup` answers them `no_access`, `former` (by default) or `erased` |
| Links and uploads | The fake serves the team host's part of the files on its own origin (`chest.api`): a link from `files.url` opens the content it was signed for (the image itself for a thumbnail — a fake does not reduce it; `no_thumbnail` for a file that is not a JPEG, PNG, GIF or WebP image), until it expires or the file changes; an address from `files.uploadUrl` takes one `PUT`, within its life, of the types and size it names and whose first bytes are those of its type (403 `invalid_token`, 415 `type_refused`, 400 `type_mismatch`, 413 `too_large`, as the Chest's), named by the Chest in a folder (20 hex characters and the type's ending), and answers `201 {name, type, size}`. It checks no session: a test's `fetch` is the member's browser |
| `chest.emit(event, to)` | Delivers an event (`{type, data, id?, occurredAt?}`: a new id and now by default; name an id to deliver the same event twice) signed as the Chest signs it, to `to` — the tool's address (`POST <to>/chest-events`) or a function of a Web `Request` — and says the status it answered. A `member.erased` makes its erasure one the tool may acknowledge |
| `ai: {models?, reply?, cap?, unavailable?}` | The fake Chest's AI, deterministic and without any provider. `models`: the aliases the tool declared, `{alias, model, provider?, input?, output?}` (all four by default, `fake-default`…`fake-embedding`, provider `openrouter`, 1 and 2 USD per million tokens); another alias answers `model_not_allowed`. `reply(request)`: what a chat answers, given the wire request — a string, or `{text?, toolCalls?: {name, arguments, id?}[]}` (by default the last user message, echoed); streamed, it comes word by word, each tool call's arguments in two pieces, then the finish reason and the usage. Embeddings are unit vectors from a hash of each text (8 dimensions unless `dimensions`). Tokens count one per 4 characters; once the spending reaches `cap` (euros, 5 by default; 0 refuses at once) a call answers `cap_reached`. `unavailable` (`no_connector`, `provider_key_invalid`, `provider_unavailable`) makes chat and embeddings answer it. 60 requests a minute |
| `chest.run(name, to, {id?, scheduledAt?, attempt?})` | Delivers a run of the schedule `name` (a new id, now and attempt 1 by default; name an id to deliver the same run twice) signed as the Chest signs it, to `to` — the tool's address (`POST <to>/chest-schedules`) or a function of a Web `Request` — and says the status it answered |
| `chest.ai` | The tool's calls to AI, `{path, body}` in order (`body` null for a `GET`) |
| `chest.acknowledged` | The erasures the tool acknowledged, each once |
| `chest.members`, `chest.groups`, `chest.files` | What the fake Chest holds, to change or assert on; its `members` are those who have the tool |
| `chest.notifications`, `chest.badges` | What the tool sent: the items kept, `{member, title, body?, path, key?}` cleaned as the Chest cleans them, in the order sent (a replaced item removed, the new one last; `withdraw` removes), and each member's badge (`Map` member → count; 0 removes it) |
| `chest.close()` | Stops it and restores the environment |

## Version

The package version is `version` in `package.json` (semver), published by a
tag `vX.Y.Z` (see `PUBLISHING.md`). Its MAJOR.MINOR is the version of the
tool contract it is written for (`"chest"` in `chest.json`): 0.4.x for the
contract 0.4. A new contract version is a new MINOR of the SDK.

## The MCP server

The MCP server an assistant runs to work on a Chest, `@argentic/chest-mcp`,
lives in its own repository:
[chest-by-argentic/Chest-MCP](https://github.com/chest-by-argentic/Chest-MCP).

## What this repository is not

This repository is public and **is not a tool**: it has no `chest.json`, and a
Chest's catalogue — which only lists the organisation's public repositories
that carry a manifest — never offers it.

## Develop

```sh
npm ci
npm test               # build dist/, compile the tests into build/, check that
                       # contract/README.md says what contract.json says, run them,
                       # then check/'s (the chest command)
npm run check:package  # npm pack both packages, the SDK under 200 KiB, install into a
                       # temp project, run chest check, import every subpath from Node
                       # and through esbuild, type-check a TS consumer
```

`contract/contract.json`, `check/check.wasm.gz` and
`check/check.wasm.sha256` are written by the Chest's repository
(`scripts/build-contract.mjs`) from the code that decides; never edit them
here. `npm run contract` renders the parts of `contract/README.md` they say;
the words around them are written here. `check/` is the workspace of
`@argentic/chest-check`, released with the SDK under the same version
(`PUBLISHING.md`); `check/src/cli.ts` is the `chest` command.

`client/src` holds the modules, `client/index.ts` the package root,
`client/test` the tests. `npm run build` compiles `client/index.ts`, the
nine published modules (`errors`, `member`, `members`, `database`, `files`,
`notifications`, `events`, `ai`, `testing`) and the one they share (`api`, the Chest's API) —
TypeScript strict, ES2022, NodeNext — into `dist/`: ESM `.js`, `.d.ts` and
their maps. `member.ts` imports nothing but `node:*`, so that a tool may copy
it alone.
The package stays dependency-free (`node:*` only) and reaches nothing but the
Chest's API on `127.0.0.1`. `AGENTS.md` is a usage guide for AI agents
building a tool with this package.

## Licence

MIT (`LICENSE`), © 2026 Argentic.
