import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { chest } from "../src/chest.js";
import { ChestError } from "../src/errors.js";
import { fakeChest } from "../src/testing.js";

const names = ["CHEST_ORGANIZATION", "CHEST_TIME_ZONE", "CHEST_LANGUAGE"];
const set = (values: Record<string, string>): void => void Object.assign(process.env, values);
const notInChest = (e: unknown): boolean => e instanceof ChestError && e.code === "not_in_chest";

afterEach(() => { for (const name of names) delete process.env[name]; });

test("the Chest is what its environment says: organization, time zone, language", () => {
  set({ CHEST_ORGANIZATION: "Société Générale d'Étude", CHEST_TIME_ZONE: "America/Argentina/Buenos_Aires", CHEST_LANGUAGE: "fr" });
  assert.deepEqual(chest.organization, { name: "Société Générale d'Étude" });
  assert.equal(chest.timeZone, "America/Argentina/Buenos_Aires");
  assert.equal(chest.language, "fr");
  // Read at each access: a Chest started again with other values says them.
  set({ CHEST_ORGANIZATION: "\u{1F3E2}".repeat(80), CHEST_TIME_ZONE: "UTC", CHEST_LANGUAGE: "haw" });
  assert.equal(chest.organization.name, "\u{1F3E2}".repeat(80));
  assert.equal(chest.timeZone, "UTC");
  assert.equal(chest.language, "haw");
});

test("today is the Chest's day, not the server's: after 22:00 UTC it is already tomorrow in Paris", () => {
  set({ CHEST_ORGANIZATION: "Acme SAS", CHEST_TIME_ZONE: "Europe/Paris", CHEST_LANGUAGE: "en" });
  const lateInUtc = Date.UTC(2026, 8, 29, 22, 30);
  assert.equal(chest.today(lateInUtc), "2026-09-30");
  assert.equal(chest.today(new Date(lateInUtc)), "2026-09-30");
  set({ CHEST_TIME_ZONE: "America/Los_Angeles" });
  assert.equal(chest.today(lateInUtc), "2026-09-29");
  set({ CHEST_TIME_ZONE: "UTC" });
  assert.match(chest.today(), /^\d{4}-\d{2}-\d{2}$/u);
  // Taken apart from the object, it still reads the Chest.
  const { today } = chest;
  assert.equal(today(lateInUtc), "2026-09-29");
  assert.throws(() => chest.today(Number.NaN), RangeError);
});

test("outside a Chest, or with a value the Chest never gives, reading it throws not_in_chest", () => {
  assert.throws(() => chest.organization, notInChest);
  assert.throws(() => chest.timeZone, notInChest);
  assert.throws(() => chest.language, notInChest);
  assert.throws(() => chest.today(), notInChest);
  for (const [name, value] of [
    ["CHEST_ORGANIZATION", "A"], ["CHEST_ORGANIZATION", "A".repeat(81)], ["CHEST_ORGANIZATION", "Acme\nSAS"], ["CHEST_ORGANIZATION", "Acme\u0085SAS"],
    ["CHEST_TIME_ZONE", ""], ["CHEST_TIME_ZONE", "Europe/Atlantis"], ["CHEST_TIME_ZONE", "CET"], ["CHEST_TIME_ZONE", "../etc/localtime"], ["CHEST_TIME_ZONE", "+02:00"],
    ["CHEST_LANGUAGE", "fr-FR"], ["CHEST_LANGUAGE", "French"], ["CHEST_LANGUAGE", "EN"],
  ] as const) {
    set({ CHEST_ORGANIZATION: "Acme SAS", CHEST_TIME_ZONE: "UTC", CHEST_LANGUAGE: "en", [name]: value });
    const read = { CHEST_ORGANIZATION: () => chest.organization, CHEST_TIME_ZONE: () => chest.timeZone, CHEST_LANGUAGE: () => chest.language }[name];
    assert.throws(read, notInChest, `${name}=${JSON.stringify(value)}`);
  }
});

test("a fake Chest is the Chest a test names, and restores the environment when closed", async () => {
  process.env["CHEST_TIME_ZONE"] = "Asia/Tokyo";
  const fake = await fakeChest({ chest: { organization: "Atelier SAS", timeZone: "Europe/Paris", language: "fr" } });
  try {
    assert.deepEqual([chest.organization.name, chest.timeZone, chest.language], ["Atelier SAS", "Europe/Paris", "fr"]);
    assert.equal(chest.today(Date.UTC(2026, 8, 29, 22, 30)), "2026-09-30");
  } finally {
    await fake.close();
  }
  assert.equal(process.env["CHEST_TIME_ZONE"], "Asia/Tokyo");
  assert.throws(() => chest.organization, notInChest);
});
