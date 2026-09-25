import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { databaseUrl } from "../src/database.js";
import { CapabilityNotGranted, ChestError } from "../src/errors.js";

// The address as the Chest's launcher builds it (chest/sourcebuild/launcher.mjs).
const given = "postgres://t_web:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8@127.0.0.1:41234/t_web?sslmode=disable";
const before = process.env["DATABASE_URL"];
afterEach(() => {
  if (before === undefined) delete process.env["DATABASE_URL"];
  else process.env["DATABASE_URL"] = before;
});

test("the database the Chest gives is read as it is", () => {
  process.env["DATABASE_URL"] = given;
  assert.equal(databaseUrl(), given);
});

test("without the capability, CapabilityNotGranted: its code, status 403, no value in its message", () => {
  delete process.env["DATABASE_URL"];
  assert.throws(() => databaseUrl(), (error: unknown) => error instanceof CapabilityNotGranted && error instanceof ChestError && error.code === "capability_not_granted" && error.status === 403 && error.name === "CapabilityNotGranted");
  // A DATABASE_URL of the tool's own is not the Chest's database.
  for (const other of [
    "postgres://app:s3cret@db.example.com:5432/app",
    "postgresql://t_web:s3cret@127.0.0.1:41234/t_web?sslmode=disable",
    "postgres://t_web:s3cret@localhost:41234/t_web?sslmode=disable",
    "postgres://t_web:s3cret@127.0.0.1:41234/t_other?sslmode=disable",
    "postgres://t_web:@127.0.0.1:41234/t_web?sslmode=disable",
    "postgres://t_web:s3cret@127.0.0.1:41234/t_web",
    "postgres://t_web:s3cret@127.0.0.1/t_web?sslmode=disable",
    "not a url",
    "",
  ]) {
    process.env["DATABASE_URL"] = other;
    assert.throws(() => databaseUrl(), (error: unknown) => error instanceof CapabilityNotGranted && !error.message.includes("s3cret"), other);
  }
});
