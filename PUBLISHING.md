# Publishing `@argentic/chest-sdk`

This repository holds two packages of one version: the runtime client
`@argentic/chest-sdk` (the root), published by a tag, and the development
tool `@argentic/chest-check` (`check/`, an npm workspace: `chest check`, the
Chest's validator in WebAssembly, kept out of the runtime client so that a
tool's image stays small). The checker is **not published yet**: it is
`"private": true` and used from a clone of this repository (README, “Check a
tool”). Both `package.json` carry the same version all the same.

For maintainers. Releases are published to npm by GitHub Actions through npm
**trusted publishing** (OIDC): no npm token exists anywhere, and every version
carries a provenance attestation linking it to its commit and workflow.

Requirements (npm documentation,
[Trusted publishing](https://docs.npmjs.com/trusted-publishers)): npm CLI
11.5.1 or later and Node 22.14.0 or later in the workflow, the
`id-token: write` permission, and `repository.url` in `package.json` matching
this GitHub repository exactly.

## Releasing a version

1. In a pull request, bump the version (the lockfile follows):

   ```sh
   npm version 0.1.1 --no-git-tag-version --workspaces --include-workspace-root
   ```

   Before 1.0: `0.1.x` for a fix, `0.2.0` for an addition or an API change.
2. Merge the pull request once CI is green.
3. Tag the merged `main` and push the tag:

   ```sh
   git switch main
   git pull --ff-only
   git tag v0.1.1
   git push origin v0.1.1
   ```

4. The **Publish** workflow (`.github/workflows/publish.yml`) checks that the
   tag equals the `package.json` version, runs the tests and the package check,
   then publishes with provenance.

If the tag does not match `package.json`, the workflow stops before
publishing. Remove the tag and start again:

```sh
git tag -d v0.1.1
git push origin --delete v0.1.1
```

A published version is never republished under the same number: publish the
next one. `npm deprecate @argentic/chest-sdk@0.1.1 "…"` flags a faulty
version; avoid `npm unpublish`.

## Trusted publisher settings

On npmjs.com, package **Settings** → **Trusted Publisher** → **GitHub
Actions**:

- Organization or user: `chest-by-argentic`
- Repository: `Chest-SDK`
- Workflow filename: `publish.yml`
- Environment name: empty

Then, under **Publishing access**, choose **Require two-factor authentication
and disallow tokens**. The same connection can be set from the command line
with npm 11.15.0 or later:

```sh
npm trust github @argentic/chest-sdk --file publish.yml --repo chest-by-argentic/Chest-SDK --allow-publish
```

Trusted publishing can only be configured on a package that already exists;
the first version was published once by hand, with `--provenance=false`
(provenance can only be generated in CI).

## When `@argentic/chest-check` is published

Not decided yet. The day it is: remove `"private": true` from
`check/package.json` and give it `"publishConfig": {"access": "public",
"provenance": true}`; publish its first version once by hand (`npm publish -w
check --provenance=false`); set its trusted publisher to this repository and
`publish.yml` (`npm trust github @argentic/chest-check --file publish.yml
--repo chest-by-argentic/Chest-SDK --allow-publish`); then have
`publish.yml` check `check/package.json`'s version against the tag too and
run `npm publish -w check` after the SDK.
