# Chest SDK

`@argentic/chest-sdk` is what a tool embeds to talk with its Chest. A server
tool (contract v2) reads the member the Chest asserts on a request, the address
of its own database and its private files. A worker (contract v1) reads its
invocations and its record on the private channel the Core attaches to it. The
SDK has no dependency: it only imports `node:*`.

```sh
npm install @argentic/chest-sdk
```

Node 22 or later. ESM only, compiled JavaScript with its type declarations.

## Imports

Each module is its own subpath and pulls in nothing else; the root gives them
all, with the files API as the namespace `files`.

| Import | Gives |
|---|---|
| `@argentic/chest-sdk/member` | `member(request)`, type `Member`: the member of a request on the team host of a server tool, read from the `Chest-Member` assertion and verified; `null` without a valid assertion |
| `@argentic/chest-sdk/database` | `databaseUrl()`: the address of the tool's own PostgreSQL database (capability `database`) |
| `@argentic/chest-sdk/files` | `put`, `get`, `list`, `delete`, `url`, types `FileObject`, `FileData`, `FilePage`: the tool's private files (capability `files`), kept by the Chest, and a 15-minute signed link to one |
| `@argentic/chest-sdk/errors` | `ChestError` (`code`, `status`), `CapabilityNotGranted` (403), `TooLarge` (413), `QuotaExceeded` (429), `Unavailable` (503): what the SDK throws when the Chest does not give what a tool asks |
| `@argentic/chest-sdk/worker` | `serve`, `runWorker`, type `Handler`: the loop of a worker, one invocation at a time, 503 `expired` past the deadline, never a replay of a write whose result is uncertain |
| `@argentic/chest-sdk/requests` | `ChestRequests`, `invocation()`, types `Invocation`, `Actor`: the invocations the Chest hands to a worker (permission `requests`) and their validated envelope — `id`, `operation`, `input`, `actor` (`subject`, `manage`, `publish`, `role`), `deadline` |
| `@argentic/chest-sdk/record` | `ChestRecord`, type `RecordRepository`: the worker's persistent value (permission `record`), read and written whole |
| `@argentic/chest-sdk/channel` | `ChestChannel`, `ChestServiceError`: one HTTP exchange at a time on the private channel (stdout/stdin of the worker), bounded answers |
| `@argentic/chest-sdk` | all of the above; `files` as a namespace |

```ts
import { member } from "@argentic/chest-sdk/member";
import { databaseUrl } from "@argentic/chest-sdk/database";
import * as files from "@argentic/chest-sdk/files";
import { CapabilityNotGranted } from "@argentic/chest-sdk/errors";
// or: import { member, databaseUrl, files } from "@argentic/chest-sdk";
```

Types refer to `node:http` (`IncomingMessage`): a TypeScript project needs
`@types/node`, as any Node project does. Both `moduleResolution` `bundler` and
`nodenext` work.

### Next.js

The SDK runs on the server only — it reads the tool's environment
(`CHEST_TOKEN`, `DATABASE_URL`, `CHEST_API`) and uses Node built-ins. Import it
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

The Core picks the tool's instance and attaches its private pipes; a worker
asks for its services by HTTP on those pipes and nothing else: no HTTP server,
no network access, no secret. Rights come only from the envelope the Chest
hands over — a business field never grants a right — and the Chest's broker
enforces the manifest's permissions even outside the SDK: the SDK makes the
calls easier, it is not a security boundary. The full contract (permissions,
`chest.json` manifest, build from source, catalogue) is described in the Chest
repository, `docs/architecture.md`, section « Contrat applicatif actuel ».

## `member(request)` — server tool (contract v2)

A v2 tool is an ordinary web server; on its team host, the Chest relays
`/chest` and everything below it with the `Chest-Member` header of the
signed-in member. `member(request)` accepts a Node request (`IncomingMessage`)
or a Web `Request` and returns:

```ts
type Member = { id: string; firstName: string; lastName: string; name: string; email: string; photo?: string; role?: string; isAdmin: boolean; isBuilder: boolean };
```

or `null`: without the header, on the public host (the Chest never sends an
assertion there and strips a client's), or for any assertion that is not
exactly its own. Checks: compact JWS, header exactly
`{"alg":"HS256","typ":"JWT"}`, HMAC-SHA256 signature compared in constant time
under the key HMAC-SHA256("Chest-Member v1") of the text of `CHEST_TOKEN` —
the Chest's derivation —, `aud` equal to `CHEST_TOOL`, `iat` and `exp` within
5 s, the shape of each claim (an unknown claim is ignored). Without
`CHEST_TOKEN` or `CHEST_TOOL`, nobody is a member. The function never throws
for what a request carries.

```ts
import { member } from "@argentic/chest-sdk/member";
const who = member(request);
if (!who) { response.writeHead(401).end(); return; }
```

`photo` is the address of the photo on the team host, `role` the role the
Chest gives the member among those the manifest declares. Only the Chest's
front reaches the container: the signature is a second defence; business rules
(who writes what) remain the tool's.

## `databaseUrl()` — database of a server tool

A v2 tool that declares `"capabilities": ["database"]` in its `chest.json`
gets a PostgreSQL database of its own (the capability is shown and approved
like a permission, « Base de données »). The container has no network: its
launcher listens on `127.0.0.1` and relays each connection to the Chest. The
launcher sets `DATABASE_URL` —
`postgres://<user>:<password>@127.0.0.1:<port>/<database>?sslmode=disable`,
the user and the database both named `t_<tool>` — and `PGHOST`, `PGPORT`,
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

A v2 tool that declares `"capabilities": ["files"]` (« Fichiers » at approval)
keeps private files **through its Chest**, never on its disk (the container's
root is read-only): 1 GiB and 10,000 objects per tool, 32 MiB per object. The
launcher gives the tool `CHEST_API=http://127.0.0.1:<port>` — its own port,
relayed to the Chest; the container has no network — and the instance is the
identity: the tool reaches its own files only.

```ts
import * as files from "@argentic/chest-sdk/files";
await files.put("photos/cat.png", bytes, "image/png");       // Uint8Array or text
const file = await files.get("photos/cat.png");              // {data, type, size} or null
const { files: page, next } = await files.list({ prefix: "photos/" }); // 1000 per page
await files.delete("photos/cat.png");                        // true, or false if it did not exist
const { url, expiresIn } = await files.url("photos/cat.png");
```

A name: up to 8 segments of 1 to 100 letters, digits, `.`, `_` or `-`,
separated by `/`, none starting with `.` or `-`; refused before anything is
sent otherwise (`ChestError`, `invalid_name`). `url` signs a link to the file
as it is, on the tool's **team host** (`/_chest/files/…`): whoever has it opens
it without signing in for 15 minutes, or until the file changes or goes; the
Chest serves it in a sandbox, displayed for an image, a PDF or plain text,
downloaded otherwise. Give it to a member's browser, never to a public page.
Errors: `CapabilityNotGranted` (a version without the capability, or no
`CHEST_API`), `TooLarge` (413), `QuotaExceeded` (429), `Unavailable` (the
Chest not reached, or an answer that is not its own: a write may or may not
have happened), `ChestError` for the rest (`invalid_type`, `not_found` for
`url`…). Removing the tool removes its files; a new version keeps them.

## Vendored copies

Before the npm package, a tool carried a **vendored copy** of `client/src`
(and `client/test`) under `packages/chest-client`, compiled with its own
sources; these copies still exist:

- in the Chest repository, `tests/sdk/chest-client` and `tests/creator` are
  refreshed from this repository by `npm run sync:sdk`
  (`scripts/sync-sdk.mjs`, an exact file list), which writes their
  `VENDORED.md`;
- a starter project is assembled by `tests/export/export-creator.mjs` of the
  Chest repository (the template + the client + the sample tool
  `apps/testapp`);
- a tool is exported by `tests/export/export-store.mjs`, which copies the
  client into it; the store's tools (`chest-by-argentic/forms`, the test bench
  `PaulWCZ/TestAppChestGithub`…) keep the same layout, `packages/chest-client`
  with its `VENDORED.md`.

`template/` is the starter project a tool author receives; it is not part of
the npm package.

## Version

The package version is `version` in `package.json` (semver), published by a
tag `vX.Y.Z` (see `PUBLISHING.md`). A vendored copy names the Git commit it
was taken from in its `VENDORED.md`.

## What this repository is not

This repository is public and **is not a tool**: it has no `chest.json`, and a
Chest's catalogue — which only lists the organisation's public repositories
that carry a manifest — never offers it.

## Develop

```sh
npm ci
npm test               # build dist/, compile the tests into build/, run them
npm run check:package  # npm pack, install into a temp project, import every subpath
                       # from Node and through esbuild, type-check a TS consumer
```

`client/src` holds the modules, `client/index.ts` the package root,
`client/test` the tests. `npm run build` compiles `client/index.ts` and
`client/src` (TypeScript strict, ES2022, NodeNext) into `dist/`: ESM `.js`,
`.d.ts` and their maps. Read `AGENTS.md` before changing anything.

## Licence

MIT (`LICENSE`), © 2026 Argentic.
