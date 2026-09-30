# chest check

`@argentic/chest-check` answers “will a Chest take this repository?” with
the Chest's own code: the validator a Chest runs on every source it builds,
compiled to WebAssembly and run by Node's WASI. A development tool: the
runtime client of a tool is `@argentic/chest-sdk`, which stays small. It is
**not published on npm yet** (`"private": true`): use it from a clone of
this repository.

```sh
# once, in a clone of chest-by-argentic/Chest-SDK (not on npm yet)
npm ci                                   # builds check/ too
npx chest check /path/to/the/tool        # --json for agents and CI
# or, in the tool's repository, a local devDependency
npm install --save-dev /path/to/Chest-SDK/check
npx chest check
```

It judges the repository as the Chest would receive it — the files Git
tracks or would add, as they are now, committed or not — and says `OK` with
the tool's name, roles, what it asks and its migrations, or `Refused` with
the Chest's reason (`manifest`, `migrations`, `no_lock`, `newer_chest`…) and
the rule broken; exit status 0, 1, or 2 when it could not run (not a Git
repository). It reads nothing but the archive it is given, and needs no
network and no Chest.

Its MAJOR.MINOR is the version of the tool contract it judges by, the same
as `@argentic/chest-sdk`'s. The contract itself, every rule, is
[`contract/README.md`](../contract/README.md) of this repository.
`check.wasm.gz` and `check.wasm.sha256` are written by the Chest's
repository from its code; never edit them here.
