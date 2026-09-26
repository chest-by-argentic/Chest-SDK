# Publishing `@argentic/chest-sdk`

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
   npm version 0.1.1 --no-git-tag-version
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
