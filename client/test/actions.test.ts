import assert from "node:assert/strict";
import { mock, test } from "node:test";
import * as actions from "../src/actions.js";
import * as schedules from "../src/schedules.js";
import type { Member } from "../src/member.js";
import { fakeChest } from "../src/testing.js";

// A call the Chest signed (chest/toolfront, Go: TestActionSignatureVector)
// for the tool "web", at 1790000000, with the instance key 00 01 … 1f, and
// the member it signed then (TestMemberAssertionVector): the derivation of
// the keys, the claims and the digest are the Chest's, not this test's.
const chestToken = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const signedAt = 1790000000;
const signedBody = `{"input":{"section":"insurance"}}`;
const signedByChest = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOiJ3ZWIiLCJkaWdlc3QiOiJ2RDdKRnZ6Vm82LVdUR29ibmEtbjkzZ3lNeEpQanJNcTVYYmNnWVI4d240IiwiZXhwIjoxNzkwMDAwMDYwLCJpYXQiOjE3OTAwMDAwMDAsImp0aSI6ImFjdF9rMnFoeDRtemM3djNiNm5mcDVyMnQ3dzR5YSJ9.1yxHvXdQm1DOPpGNw10HAWlHUzoO-hdgtuHBlBAVBWM";
const memberByChest = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhZG1pbiI6dHJ1ZSwiYXVkIjoid2ViIiwiYnVpbGRlciI6ZmFsc2UsImVtYWlsIjoiYWxpY2VAZXhhbXBsZS50ZXN0IiwiZXhwIjoxNzkwMDAwMDYwLCJmYW1pbHlfbmFtZSI6Ik1hcnRpbiIsImdpdmVuX25hbWUiOiJBbGljZSIsImdyb3VwcyI6WyJncnBfbjRyZHE3dzJ4a3o1bTNidmM2aHkydHBsNGUiXSwiaWF0IjoxNzkwMDAwMDAwLCJpc3MiOiJodHRwczovL3dlYi1jaGVzdC5hdGVsaWVyLmV4YW1wbGUiLCJsYW5ndWFnZSI6ImZyIiwibmFtZSI6IkFsaWNlIE1hcnRpbiIsInBpY3R1cmUiOiIvX2NoZXN0L21lbWJlcnMvbWJyX2sycWh4NG16Yzd2M2I2bmZwNXIydDd3NHlhL3Bob3RvP3Y9YWJjZGVmZ2giLCJyb2xlIjoiZWRpdG9yIiwic3ViIjoibWJyX2sycWh4NG16Yzd2M2I2bmZwNXIydDd3NHlhIiwidGltZV96b25lIjoiRXVyb3BlL1BhcmlzIn0.Gn-eYBi3X4qkdZeL0IOT8p7QYUAURLZxeTh7UeUQrQI";

async function inChest<T>(body: () => Promise<T>): Promise<T> {
  const saved = [process.env["CHEST_TOKEN"], process.env["CHEST_TOOL"]];
  process.env["CHEST_TOKEN"] = chestToken;
  process.env["CHEST_TOOL"] = "web";
  try {
    return await body();
  } finally {
    mock.timers.reset();
    for (const [name, value] of [["CHEST_TOKEN", saved[0]], ["CHEST_TOOL", saved[1]]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const call = (path = "/chest-actions/add-paper", headers: Record<string, string> = { "Chest-Action": signedByChest, "Chest-Member": memberByChest }, body = signedBody) =>
  new Request("http://tool.test" + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });

test("a call signed by the Chest reads as the action, its input and its member", () => inChest(async () => {
  mock.timers.enable({ apis: ["Date"], now: signedAt * 1000 });
  const read = await actions.read(call());
  assert.equal(read?.id, "act_k2qhx4mzc7v3b6nfp5r2t7w4ya");
  assert.equal(read?.name, "add-paper");
  assert.deepEqual(read?.input, { section: "insurance" });
  assert.equal(read?.member.id, "mbr_k2qhx4mzc7v3b6nfp5r2t7w4ya");
}));

test("a call is neither a run nor anything but the Chest's, in a member's name", () => inChest(async () => {
  mock.timers.enable({ apis: ["Date"], now: signedAt * 1000 });
  // The call's signature as a run's, a run's header on a call: the keys differ.
  assert.equal(await schedules.verify(call("/chest-schedules", { "Chest-Schedule": signedByChest })), null);
  assert.equal(await actions.read(call(undefined, { "Chest-Schedule": signedByChest, "Chest-Member": memberByChest })), null);
  // No member, another body, another path, an action's name out of grammar.
  assert.equal(await actions.read(call(undefined, { "Chest-Action": signedByChest })), null);
  assert.equal(await actions.read(call(undefined, undefined, signedBody.replace("insurance", "legal"))), null);
  assert.equal(await actions.read(call("/chest/actions/add-paper")), null);
  assert.equal(await actions.read(call("/chest-actions/Add_Paper")), null);
  mock.timers.setTime((signedAt + 65) * 1000);
  assert.equal(await actions.read(call()), null);
}));

const camille: Member = { id: "mbr_camilleaaaaaaaaaaaaaaaaaaa", firstName: "Camille", lastName: "Durand", name: "Camille Durand", photo: null, role: null, isAdmin: false, isBuilder: false, groups: [], language: "en", timeZone: "Europe/Paris" };

test("handle answers the handler's sentence, its refusals by their code", async () => {
  const chest = await fakeChest({ members: [camille] });
  try {
    const tool = async (request: Request) => {
      const { status, body } = await actions.handle(request, {
        "add-paper": ({ input, member }) => {
          if (input["section"] === "hr") throw new actions.Refused("refused", "not for this member");
          if (typeof input["section"] !== "string") throw new actions.Refused("invalid_input");
          return { said: ` Filed in ${input["section"]} for ${member.firstName} ` };
        },
        record: () => ({ said: "The company's record", data: { name: "Atelier" } }),
      });
      return new Response(body, { status });
    };
    assert.deepEqual(await chest.act("add-paper", { section: "insurance" }, camille, tool), { status: 200, body: { said: "Filed in insurance for Camille" } });
    assert.deepEqual(await chest.act("record", {}, camille, tool), { status: 200, body: { said: "The company's record", data: { name: "Atelier" } } });
    assert.deepEqual(await chest.act("add-paper", { section: "hr" }, camille, tool), { status: 403, body: { error: "refused" } });
    assert.deepEqual(await chest.act("add-paper", {}, camille, tool), { status: 400, body: { error: "invalid_input" } });
    assert.deepEqual(await chest.act("remove", {}, camille, tool), { status: 404, body: { error: "not_found" } });
    assert.equal((await tool(new Request("http://tool.test/chest-actions/record", { method: "POST", body: "{}" }))).status, 401);
  } finally {
    await chest.close();
  }
});

test("an answer is one printable sentence and 64 KiB at most", () => {
  assert.equal(actions.answer("Done"), `{"said":"Done"}`);
  assert.throws(() => actions.answer("  "));
  assert.throws(() => actions.answer("x".repeat(281)));
  assert.throws(() => actions.answer("a‮b"));
  assert.throws(() => actions.answer("Done", "x".repeat(64 << 10)));
});
