# The tool contract

What a Chest takes from a tool, and what it gives it: the manifest
`chest.json`, the repository it builds, the migrations it plays, the
Content-Security-Policy it adds. The SDK (`../README.md`) is the other half:
what a running tool calls.

<!-- contract:version -->
Version **0.5** — `"chest": "0.5"`, the SDK 0.5.x.
<!-- /contract:version -->

**One source.** The rules below are the Chest's own code: the tables and
lists of rules are rendered from [`contract.json`](contract.json), which the
Chest's repository writes from the packages that decide, together with
[`check.wasm.gz`](../check/check.wasm.gz), those packages compiled to
WebAssembly — what `chest check` (`@argentic/chest-check`) runs. The Chest's tests fail when either differs from its
code; this repository's tests fail when this page differs from
`contract.json`, or when `check.wasm.gz` says another contract.

## Check a repository

```sh
# once, in a clone of chest-by-argentic/Chest-SDK (not on npm yet)
npm ci                                   # builds check/ too
npx chest check /path/to/the/tool        # --json for agents and CI
# or, in the tool's repository, a local devDependency
npm install --save-dev /path/to/Chest-SDK/check
npx chest check
```

It reads the repository as the Chest would receive it — the files Git
tracks or would add, the working tree as it is now, committed or not — and
judges it with the Chest's code:

```
OK: the Chest (tool contract 0.5) would take tasks, written for contract 0.5.
  Roles: manager, member
  It asks: database, files, members
  Migrations: 3
```

```
Refused: manifest
  source refused: manifest: invalid field "title"
```

Exit status 0 when the Chest would take it, 1 when it would refuse it, 2
when it could not be checked (not a Git repository). The reason is the word
the Chest's own pages say it with: `no_manifest`, `no_package`, `no_lock`,
`manifest`, `newer_chest`, `migrations`, `node_modules`, `link`, `tree`,
`picture`, `too_large`, `archive`. Perseus, the Chest's build agent, runs the
same code on its drafts.

## Versions

`"chest"` names the version of the contract a tool is written for: the
MAJOR.MINOR of the SDK it uses (SDK 0.5.x: `"chest": "0.5"`). A Chest serves
every version up to its own, with the one grammar it has: the contract only
grows, and a key keeps its meaning once in it. A Chest older than the version
a tool names refuses it before reading anything else, and says so to whoever
installs it: “This tool needs a newer version of your Chest”. Up to its own
version, a key it does not know is refused, never ignored — an ignored key
could be a permission nobody approved.

## `chest.json`

<!-- contract:keys -->
`chest.json`, at the root of the repository, 16 KiB at most. Unknown and duplicate keys are refused.

| Key | | Rule | Example |
|---|---|---|---|
| `chest` | required | The version of the tool contract the tool is written for, "MAJOR.MINOR" — the SDK's MAJOR.MINOR. A Chest serves every version up to its own; an older Chest refuses the tool before reading anything else: "This tool needs a newer version of your Chest". Grammar: `^(0\|[1-9][0-9]{0,2})\.(0\|[1-9][0-9]{0,2})$`. | `"0.5"` |
| `name` | required | The tool's name and the label of its address: a lowercase letter, then up to 47 lowercase letters, digits or dashes; never login, node, nor a name ending in -chest. Whoever installs the tool may give it another address. Grammar: `^[a-z][a-z0-9-]{0,47}$`. | `"tasks"` |
| `title` |  | Shown in lists: 1 to 48 printable characters. | `"Tasks"` |
| `description` |  | Shown in the catalogue: 1 to 160 printable characters. | `"The team's tasks, by project."` |
| `icon` |  | The tool's icon, a file of the chest/ directory: SVG or PNG, 64 KiB at most. Grammar: `^chest/[a-z0-9][a-z0-9._-]{0,63}\.(svg\|png)$`. | `"chest/icon.svg"` |
| `preview` |  | A picture of the tool for the catalogue, a file of the chest/ directory: PNG, JPEG or WebP, 512 KiB at most. Grammar: `^chest/[a-z0-9][a-z0-9._-]{0,63}\.(png\|jpg\|jpeg\|webp)$`. | `"chest/preview.png"` |
| `roles` |  | The roles a member holds in the tool, the first the default: 1 to 16 distinct identifiers, each of the grammar of name. The tool is told each member's role; its own code decides what a role may do. Grammar: `^[a-z][a-z0-9-]{0,47}$`. | `["manager","member"]` |
| `role_labels` |  | How declared roles are shown: an object giving roles of roles 1 to 40 printable characters each. Presentation only: never approved. | `{"manager":"Manager"}` |
| `public` |  | true for a part served to anyone on the Internet, on the tool's public host, outside /chest. Approved as a permission; closed at installation until whoever runs the tool opens it. | `true` |
| `csp` |  | "tool": the public part sends its own Content-Security-Policy (a nonce per response, as Next.js needs), and the Chest adds beside it only its floor policy instead of its default one. Requires public; approved as a permission. | `"tool"` |
| `capabilities` |  | What the tool uses of its Chest, each at most once, each approved as a permission: database (its own PostgreSQL), sealed (values it seals, which only its members open through it; every version of the tool then waits for the owner or an admin), files (its private files), members (who has the tool), members.email (their addresses; with members), members.groups (every group of the Chest, and which of those members are in each; with members), notifications (badges and inbox items), ai (AI models through the Chest; with the key ai), realtime (live updates to its members' open pages; its channels in the key realtime). | `["database","sealed","files","members","members.email","members.groups","notifications","ai","realtime"]` |
| `files` |  | With the capability files: "quota" and "maxObject", sizes such as "5 GiB" or "100 MiB" — the quota from 100 MiB to 100 GiB (1 GiB without it), the largest object from 1 MiB to 512 MiB (32 MiB without it). | `{"quota":"5 GiB","maxObject":"100 MiB"}` |
| `ai` |  | Required with the capability ai: "monthly", the whole euros a month the tool suggests, 1 to 1000 (5 without it; the owner's cap decides); "models", the aliases it calls among default, fast, smart, embedding, each once (default without it); "purpose", what it does with AI, 1 to 120 printable characters. | `{"monthly":5,"models":["default","embedding"],"purpose":"Summarises the tasks of a project"}` |
| `realtime` |  | With the capability realtime: the channels the members' pages join, and the tables whose writes become live events. "channels", 1 to 32 patterns, no channel name matched by two: "name", segments of ^[a-z0-9_-]{1,64}$ joined by colons, 128 characters at most, its last segment possibly {member} (the joining member's own id only), * (any segment) or {key} (a membership table decides); "join", absent for every member who has the tool, a list of the tool's roles, or {"table", "key", "member"} — a member joins {key} when a row of table has the key in column key and their id in column member (requires database; a row deleted removes them at once); "send" true lets those who join send ephemeral messages; "presence" true lets them appear in its presence. "feeds", up to 16: "table", whose inserts, updates and deletes become events <table>.insert, .update, .delete on "channel" — a declared channel, or prefix:{column} of a variable pattern, the column giving the last segment —, each carrying "columns" (1 to 32, the primary key first) of the row. Names of tables and columns are ^[a-z_][a-z0-9_]{0,62}$. Never approved: only the capability is. | `{"channels":[{"name":"everyone","presence":true},{"name":"room:{id}","join":{"table":"room_members","key":"room_id","member":"member_id"},"send":true,"presence":true},{"name":"inbox:{member}"}],"feeds":[{"table":"messages","channel":"room:{room_id}","columns":["id","room_id","author","text","created_at"]}]}` |
| `emits` |  | The events the tool tells the other tools of the Chest, by type: two to four dotted words of lowercase letters, digits and dashes (64 characters at most; never member.* nor access.*), each {"description", "data"} — what happened in a sentence of 1 to 80 printable characters, and every field its data carries with its kind: id, text, number, boolean, time, date, member, members, ? after the kind for an optional field (camelCase names; {} for none). Data with any other field is refused, 16 KiB at most. Each type approved as a permission, with the tools it reaches; a type's data only grows from one version to the next: a field is never removed, retyped nor made optional — a new shape is a new type. | `{"task.done":{"description":"A task is done","data":{"task":"id","project":"id","doneBy":"member","note":"text?"}}}` |
| `receives` |  | The events posted to POST /chest-events: "member.*", the members' lifecycle (requires the capability members), and event types, from whichever other tool emits them — never the tool's own events. Each approved as a permission, with the tools it comes from. | `["member.*","quote.accepted"]` |
| `schedules` |  | Work the tool does by itself at set times, 1 to 8: each {"name", "cron"} — a name of its own (^[a-z][a-z0-9-]{0,31}$) and a five-field cron line (minute hour day month weekday: numbers, *, ranges, lists and steps, one space apart, Sunday 0 or 7, no names nor macros) read on the wall clock of the Chest's time zone, its runs 15 minutes apart at least. Each run is posted, signed, to POST /chest-schedules, the tool woken if it sleeps, and answered within 5 minutes. Each schedule approved as a permission; running by itself is what is approved. | `[{"name":"morning","cron":"30 7 * * 1-5"}]` |
| `network` |  | The hosts the server reaches on the Internet, 1 to 32, none covered by another: a host name, *.domain for every name under it, or * alone for any host. Each approved as a permission. Without it, the tool reaches nothing. | `["api.example.com","*.example.org"]` |
| `env` |  | The names of the variables the tool expects, 1 to 32 distinct: never PORT, HOME, PATH, HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, NO_PROXY, nor a name starting with CHEST_, NODE_, NPM_. Whoever runs the tool sets their values in the Chest, never in the code. Grammar: `^[A-Z_][A-Z0-9_]{0,63}$`. | `["TASKS_MAIL_FROM"]` |
| `build` | required | How the Chest builds and starts the tool: fixed commands run as argument vectors, never through a shell. | `{"runtime":"node","install":"npm ci","command":"npm run build","start":"npm start","port":3000,"static":["/_next/static/"]}` |
| `build.runtime` | required | "node": the Chest's pinned Node image. | `"node"` |
| `build.install` | required | "npm ci": exactly what package-lock.json says, which is required at the root. | `"npm ci"` |
| `build.command` |  | The build, "npm run <script>"; none without it. Grammar: `^[a-z0-9][a-z0-9:_-]{0,63}$`. | `"npm run build"` |
| `build.start` |  | "npm start" or "npm run <script>". Grammar: `^[a-z0-9][a-z0-9:_-]{0,63}$`. | `"npm start"` |
| `build.port` | required | The port the server listens on, 1024 to 65535; the Chest sets PORT to it. | `3000` |
| `build.static` |  | The path prefixes of built files, served as they are on both hosts: up to 4, each "/…/" (/_next/static/ without it); never /chest/, /_chest/, /chest-events/ or /chest-schedules/. | `["/_next/static/"]` |
<!-- /contract:keys -->

Every permission — `public`, `csp`, each capability, `files` beyond the
defaults, `ai`, `receives`, each `network` entry — is said to the owner in
plain words; only the owner or an admin approves it. A new version that asks
more waits for that approval; one that asks nothing more replaces the
version in service.

## The repository

<!-- contract:source -->
- At the root: `chest.json`, `package.json`, `package-lock.json`.
- At most 32 MiB compressed, 256 MiB and 20,000 files and directories unpacked.
- Refused: node_modules, anywhere: the Chest installs the dependencies from package-lock.json.
- Refused: a symbolic or hard link, a device, a socket or a pipe.
- Refused: .git, and a Dockerfile, Containerfile, .dockerignore or .containerignore directory at the root.
- Refused: extended attributes, and a path that leaves the tree.
<!-- /contract:source -->

The Chest builds with `npm ci`, then `build.command`, and starts
`build.start`, as argument vectors in its pinned Node image, without network
at run time but the hosts `network` declares. The container's root is
read-only: store files through the SDK's `files`, data in the database.

## Migrations

<!-- contract:migrations -->
- Files of `migrations/` named `^[0-9]{4}_[a-z0-9_-]{1,64}\.sql$`: 256 at most, 1 MiB each, 8 MiB in all.
- Played in the order of their names, each once, as one simple query in a transaction of its own, as the tool's database role: the owner of its database, not a superuser. Only with the capability database. UTF-8 SQL text without NUL; a migration played is never changed: a change is a new one.
- Extensions a migration may create (`create extension if not exists …`): `btree_gin`, `btree_gist`, `citext`, `cube`, `dict_int`, `fuzzystrmatch`, `hstore`, `intarray`, `isn`, `lo`, `ltree`, `pg_trgm`, `pgcrypto`, `seg`, `tablefunc`, `tcn`, `tsm_system_rows`, `tsm_system_time`, `unaccent`, `uuid-ossp`.
<!-- /contract:migrations -->

What a migration may create is what PostgreSQL lets the owner of a
database create: tables, indexes, constraints (an exclusion constraint with
`btree_gist` — “never booked twice”), views, sequences, types, functions and
triggers in SQL or PL/pgSQL, schemas, text search configurations, and the
extensions above. It may take row and table locks. Never a role, a database,
another extension, an untrusted language or a server setting: PostgreSQL
refuses them to the tool's role. A migration that has run is never edited:
a change is a new file; a rollback does not undo a migration, so the
previous version must keep working on the new schema.

## Content-Security-Policy

<!-- contract:policies -->
| Where | The Chest adds |
|---|---|
| Public host, every answer | `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'` |
| Public host of a tool with `"csp": "tool"`, beside its own policy | `frame-ancestors 'none'; base-uri 'self'; object-src 'none'` |
| Team host (`/chest`), to an answer without a policy | `frame-ancestors 'none'` |
<!-- /contract:policies -->

- **The team part** (`/chest`, on the team host) decides its own policy: the
  Chest adds only `frame-ancestors 'none'`, and only to an answer that has
  no policy.
- **The public part** gets the Chest's default policy on every answer: no
  inline script, no inline style, nothing from another origin. Two policies
  intersect, so a tool may only tighten it.
- **A framework that needs inline scripts** — Next.js does — declares
  `"csp": "tool"` (a permission) and sends its own policy on every answer,
  with a nonce per response: the Chest then adds beside it only its floor
  policy, which never blocks a script. An answer without a policy still gets
  the default one.
- **Embedded in the company's website.** The owner or an admin may allow
  sites (`https://acme.fr`) to frame the public part, in the tool's settings:
  the Chest then writes them in `frame-ancestors` instead of `'none'` on the
  public part only — its host and its custom domain —, never on `/chest`. A
  page framed by one of them gets `<script src="/_chest/frame.js" async>`
  right after its `<body>`, which tells the site the page's height; the
  site's page loads `/_chest/embed.js` beside the frame (the snippet the
  settings give). A tool with its own policy keeps it: `'self'` scripts (or
  `strict-dynamic` with that script loaded by its own nonced code) let the
  frame resize, and its own `frame-ancestors` still wins. Framed by another
  site, a page is a third-party document: keep its state in the page — a
  form's fields — rather than in cookies, which browsers block there unless
  they are `SameSite=None; Secure; Partitioned`.
- **`/_chest/` is the Chest's** on both hosts: the team host's sign-in, links
  and uploads; the public part's visitors' uploads and embedding scripts.
  The tool never receives a request under it.
- **Inline styles.** React's `style={…}` writes style attributes, which
  `style-src` does not allow without `'unsafe-inline'`: add
  `style-src-attr 'unsafe-inline'` to the tool's own policy (attributes
  only), or keep styles in stylesheets. A library that injects `<style>`
  elements needs the nonce on them (`style-src-elem 'self' 'nonce-…'`).

## Next.js on a Chest

What the Chest's first Next.js tool (Forms) settled:

- **The policy with a nonce**, in `proxy.ts`: a fresh nonce per request,
  `script-src 'self' 'nonce-…' 'strict-dynamic'`, set on the request (Next.js
  reads the nonce from it while it renders) and on the response; `"csp":
  "tool"` in `chest.json`. Render pages per request: a static page has no
  nonce.
- **The build fits the Chest's build container** (512 MiB, one CPU):
  `next build --webpack`, one worker (`experimental: {cpus: 1,
  webpackBuildWorker: false}`), no webpack cache; the types are checked by
  `tsc` in the build script, before it, not by a second process.
- **Nothing written at run time**: `images: {unoptimized: true}` (the image
  optimiser keeps a cache on disk).
- **The static files** are `/_next/static/`, the default of `build.static`.
- **Dates**: format them on the server, in the member's language and zone
  (`member.language`, `member.timeZone`): Node and browsers format them
  differently, and a page rendered twice would not hydrate.
- **Server only**: never import the SDK in a `"use client"` module; a
  function of a `"use client"` file cannot be called by a server page.
