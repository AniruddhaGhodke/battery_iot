import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Sql } from "postgres";
import { PackRegistry } from "../ingest/packs.ts";

type Row = {
  id: number;
  device_id: string;
  enabled: boolean;
  topic_slug: string | null;
  device_uid: string | null;
};

/** Enough of postgres.js to drive the registry: one select, and writes logged. */
function fakeSql(rows: Row[]) {
  const writes: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sql: any = (strings: unknown, ...values: unknown[]) => {
    if (!Array.isArray(strings) || !("raw" in strings)) return { helper: strings };
    const text = (strings as string[]).join("?").replace(/\s+/g, " ").trim();
    if (text.startsWith("select id, device_id")) return Promise.resolve(rows);
    writes.push(`${text} :: ${JSON.stringify(values)}`);
    return Promise.resolve([]);
  };
  return { sql: sql as Sql, writes };
}

const settled = () => new Promise((r) => setImmediate(r));

async function registry(rows: Row[], autoRegister = false) {
  const { sql, writes } = fakeSql(rows);
  const packs = new PackRegistry(sql, autoRegister);
  await packs.refresh();
  return { packs, writes };
}

describe("pack identity", () => {
  const pack: Row = {
    id: 7,
    device_id: "EM_PACK_40S_01",
    enabled: true,
    topic_slug: "pack1",
    device_uid: "AABBCCDDEEFF",
  };

  it("resolves on the hardware UID, so a renamed board is the same pack", async () => {
    const { packs } = await registry([pack]);
    // The board now calls itself something else. Same hardware, same history.
    assert.equal(packs.lookupByIdentity("EM_PACK_40S_99", "AABBCCDDEEFF"), 7);
    assert.equal(packs.unknown.size, 0, "a renamed board is not an unknown device");
  });

  it("writes the new name through to the packs table", async () => {
    const { packs, writes } = await registry([pack]);
    packs.noteIdentity("EM_PACK_40S_99", "AABBCCDDEEFF", "1.0.0", true);
    await settled();
    assert.ok(
      writes.some((w) => w.startsWith("update packs set device_id") && w.includes("EM_PACK_40S_99")),
      writes.join("\n"),
    );
    // And it is addressable under the new name straight away.
    assert.deepEqual(packs.resolve("EM_PACK_40S_99"), {
      packId: 7,
      slug: "pack1",
      uid: "AABBCCDDEEFF",
    });
  });

  it("records the UID the first time a board reports one", async () => {
    const { packs, writes } = await registry([{ ...pack, device_uid: null }]);
    assert.equal(packs.resolve("EM_PACK_40S_01")?.uid, null, "nothing can be sent to it yet");
    packs.noteIdentity("EM_PACK_40S_01", "AABBCCDDEEFF", "1.0.0", true);
    await settled();
    assert.ok(writes.some((w) => w.includes("set device_uid") && w.includes("firmware_version")));
    assert.equal(packs.resolve("EM_PACK_40S_01")?.uid, "AABBCCDDEEFF");
  });

  it("only writes the identity again when something changed", async () => {
    const { packs, writes } = await registry([{ ...pack, device_uid: null }]);
    for (let i = 0; i < 5; i++) {
      packs.noteIdentity("EM_PACK_40S_01", "AABBCCDDEEFF", "1.0.0", true);
    }
    await settled();
    assert.equal(writes.length, 1, "a write on every reading would be 17,000 a day");
    // A firmware version change is worth a write: it is how an update is confirmed.
    packs.noteIdentity("EM_PACK_40S_01", "AABBCCDDEEFF", "1.1.0", true);
    await settled();
    assert.equal(writes.length, 2);
  });

  it("still rejects a disabled pack, whichever name it uses", async () => {
    const { packs } = await registry([{ ...pack, enabled: false }]);
    assert.equal(packs.lookupByIdentity("EM_PACK_40S_99", "AABBCCDDEEFF"), null);
    assert.equal(packs.lookupByIdentity("EM_PACK_40S_01", null), null);
  });

  it("leaves a board with no UID to be resolved by name", async () => {
    const { packs } = await registry([pack]);
    assert.equal(packs.lookupByIdentity("EM_PACK_40S_01", null), 7);
    assert.equal(packs.lookupByIdentity("SOMEONE_ELSE", null), null);
  });

  it("does not rename onto a device_id another pack already holds", async () => {
    const other: Row = {
      id: 9,
      device_id: "EM_PACK_16S_03",
      enabled: true,
      topic_slug: "pack1",
      device_uid: null,
    };
    const { packs, writes } = await registry([pack, other]);
    packs.noteIdentity("EM_PACK_16S_03", "AABBCCDDEEFF", "1.0.0", true);
    await settled();
    assert.ok(
      !writes.some((w) => w.startsWith("update packs set device_id")),
      "that rename would collide on the unique index",
    );
    // The UID still sends its readings to its own pack, not to the other row.
    assert.equal(packs.lookupByIdentity("EM_PACK_16S_03", "AABBCCDDEEFF"), 7);
  });
});
