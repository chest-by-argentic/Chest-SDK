// Check the package as a consumer receives it: npm pack, install the tarball
// into a throwaway project, then import every subpath from Node, through a
// bundler (esbuild, as Next.js and others consume it) and type-check a
// TypeScript consumer under moduleResolution bundler and nodenext.
//
//   npm run check:package        (node scripts/check-package.mjs)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const name = manifest.name;

// What each subpath gives at run time (tool contract v2); the root gives them
// all, files as a namespace.
const expected = {
  errors: ["CapabilityNotGranted", "ChestError", "QuotaExceeded", "TooLarge", "Unavailable"],
  member: ["member"],
  database: ["databaseUrl"],
  files: ["delete", "get", "list", "put", "url"],
};
const rootExports = [...Object.entries(expected).filter(([sub]) => sub !== "files").flatMap(([, names]) => names), "files"].sort();

const subpaths = Object.keys(manifest.exports).filter(key => key !== "./package.json");
assert.deepEqual(subpaths.sort(), [".", ...Object.keys(expected).map(sub => "./" + sub)].sort(), "the exports map and this check name the same subpaths");

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
// Run from prepublishOnly, npm passes its own flags down: a dry run would
// keep npm pack from writing the tarball this check installs.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "npm_config_dry_run"));
function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}
function step(title) {
  console.log(`\n== ${title}`);
}

const work = mkdtempSync(join(tmpdir(), "chest-sdk-check-"));
try {
  step("npm pack");
  const [packed] = JSON.parse(run(npm, ["pack", "--json", "--pack-destination", work], root).replace(/^[^[]*/su, ""));
  const tarball = join(work, packed.filename);
  const shipped = packed.files.map(file => file.path).sort();
  console.log(`${packed.filename}: ${shipped.length} files, ${packed.size} bytes`);
  for (const path of shipped) console.log("  " + path);
  for (const path of shipped) {
    assert.ok(/^(package\.json|README\.md|LICENSE|dist\/.+\.(js|d\.ts)(\.map)?|client\/index\.ts|client\/src\/[a-z]+\.ts)$/u.test(path), `unexpected file in the package: ${path}`);
  }
  for (const target of Object.values(manifest.exports).flatMap(entry => typeof entry === "string" ? [entry] : Object.values(entry))) {
    assert.ok(shipped.includes(target.slice(2)), `export target missing from the package: ${target}`);
  }

  step("install the tarball into a throwaway project");
  const consumer = join(work, "consumer");
  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }) + "\n");
  run(npm, ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--no-package-lock", tarball], consumer);
  console.log(`installed ${name} in ${consumer}`);

  // The same probe runs from Node and from the bundle: every subpath, its
  // names, a class shared between subpaths and the root, and two calls that
  // need no Chest.
  const specifiers = subpaths.map(sub => sub === "." ? name : name + sub.slice(1));
  const probe = [
    ...specifiers.map((specifier, i) => `import * as m${i} from ${JSON.stringify(specifier)};`),
    `const modules = { ${specifiers.map((specifier, i) => `${JSON.stringify(specifier)}: m${i}`).join(", ")} };`,
    `const names = {};`,
    `for (const [specifier, module] of Object.entries(modules)) names[specifier] = Object.keys(module).sort();`,
    `const root = modules[${JSON.stringify(name)}];`,
    `const errors = modules[${JSON.stringify(name + "/errors")}];`,
    `const database = modules[${JSON.stringify(name + "/database")}];`,
    `delete process.env.DATABASE_URL; delete process.env.CHEST_TOKEN;`,
    `let refused = false;`,
    `try { database.databaseUrl(); } catch (error) { refused = error instanceof errors.CapabilityNotGranted && error instanceof root.ChestError; }`,
    `const nobody = modules[${JSON.stringify(name + "/member")}].member(new Request("http://tool.test/chest", { headers: { "chest-member": "a.b.c" } }));`,
    `console.log(JSON.stringify({ names, sameClass: root.ChestError === errors.ChestError, sameFiles: root.files.put === modules[${JSON.stringify(name + "/files")}].put, refused, nobody }));`,
  ].join("\n") + "\n";
  function verify(output, how) {
    const result = JSON.parse(output);
    for (const [sub, names] of Object.entries(expected)) assert.deepEqual(result.names[`${name}/${sub}`], names, `${how}: ${name}/${sub}`);
    assert.deepEqual(result.names[name], rootExports, `${how}: ${name}`);
    assert.equal(result.sameClass, true, `${how}: one ChestError for the root and /errors`);
    assert.equal(result.sameFiles, true, `${how}: one files module for the root and /files`);
    assert.equal(result.refused, true, `${how}: databaseUrl() without DATABASE_URL throws CapabilityNotGranted`);
    assert.equal(result.nobody, null, `${how}: member() without CHEST_TOKEN is null`);
    for (const specifier of specifiers) console.log(`  ${specifier}: ${result.names[specifier].join(", ")}`);
  }

  step("import every subpath from Node");
  writeFileSync(join(consumer, "probe.mjs"), probe);
  verify(run(process.execPath, ["probe.mjs"], consumer), "Node");

  step("bundle every subpath with esbuild");
  const esbuild = await import(pathToFileURL(join(root, "node_modules", "esbuild", "lib", "main.js")).href);
  const bundled = await esbuild.build({
    absWorkingDir: consumer,
    entryPoints: ["probe.mjs"],
    outfile: "bundle.mjs",
    bundle: true,
    platform: "node",
    format: "esm",
    metafile: true,
    logLevel: "warning",
  });
  const inputs = Object.keys(bundled.metafile.inputs).filter(input => input.includes(name));
  assert.ok(inputs.length > 0 && inputs.every(input => /\/dist\/.+\.js$/u.test(input)), `the bundle resolves compiled JavaScript only: ${inputs.join(", ")}`);
  console.log(`resolved ${inputs.length} modules: ${inputs.map(input => input.slice(input.indexOf(name) + name.length + 1)).join(", ")}`);
  verify(run(process.execPath, ["bundle.mjs"], consumer), "esbuild bundle");

  step("type-check a TypeScript consumer");
  writeFileSync(join(consumer, "consumer.ts"), `import type { IncomingMessage } from "node:http";
import * as sdk from "${name}";
import { CapabilityNotGranted, ChestError, QuotaExceeded, TooLarge, Unavailable } from "${name}/errors";
import { member, type Member } from "${name}/member";
import { databaseUrl } from "${name}/database";
import * as files from "${name}/files";
import type { FileData, FileObject, FilePage } from "${name}/files";

export function who(request: Request | IncomingMessage): Member | null { return member(request); }
export const url: string = databaseUrl();
export async function keep(): Promise<[FileObject, FileData | null, FilePage, boolean, { url: string; expiresIn: number }]> {
  return [await files.put("a.txt", "a", "text/plain"), await files.get("a.txt"), await files.list({ prefix: "a" }), await files.delete("a.txt"), await sdk.files.url("a.txt")];
}
export function code(error: unknown): string | null {
  if (error instanceof CapabilityNotGranted || error instanceof QuotaExceeded || error instanceof TooLarge || error instanceof Unavailable) return error.code;
  return error instanceof ChestError && error === (error satisfies sdk.ChestError) ? error.code : null;
}
`);
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  for (const [resolution, module] of [["bundler", "esnext"], ["nodenext", "nodenext"]]) {
    const config = `tsconfig.${resolution}.json`;
    writeFileSync(join(consumer, config), JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module,
        moduleResolution: resolution,
        strict: true,
        exactOptionalPropertyTypes: true,
        noEmit: true,
        skipLibCheck: false,
        types: ["node"],
        typeRoots: [join(root, "node_modules", "@types")],
      },
      files: ["consumer.ts"],
    }, null, 2) + "\n");
    run(process.execPath, [tsc, "-p", config], consumer);
    console.log(`  moduleResolution ${resolution}: no error`);
  }

  console.log(`\n${name}@${manifest.version}: package check passed`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
