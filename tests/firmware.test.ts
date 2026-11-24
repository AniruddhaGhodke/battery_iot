import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  firmwareUrl,
  IMAGE_MAGIC,
  IMAGE_MAX_BYTES,
  imageError,
  parseOtaStatus,
  SHA256_RE,
  urlError,
  versionError,
} from "../lib/firmware.ts";

/** Something shaped like an ESP32 application image. */
function image(bytes = 200_000, magic = IMAGE_MAGIC): Uint8Array {
  const b = new Uint8Array(bytes);
  b[0] = magic;
  return b;
}

describe("firmware versions", () => {
  it("accepts what the firmware's isSafeVersion accepts", () => {
    for (const ok of ["1.0.0", "1.1.0-rc2", "v2_final", "a", "9".repeat(31)]) {
      assert.equal(versionError(ok), null, ok);
    }
  });

  it("rejects what the device would reject silently", () => {
    // A command with a bad version is only logged on the device's console —
    // nothing comes back over MQTT — so it has to be caught here.
    for (const bad of ["", "   ", "1.0 beta", "pack/1", "héllo", "x".repeat(32), 42, null]) {
      assert.notEqual(versionError(bad), null, JSON.stringify(bad));
    }
  });
});

describe("firmware URLs", () => {
  it("is content-addressed, so the hash and the file cannot disagree", () => {
    const sha = createHash("sha256").update(image()).digest("hex");
    const url = firmwareUrl("https://bms.example.com", sha);
    assert.equal(url, `https://bms.example.com/firmware/${sha}.bin`);
    assert.ok(SHA256_RE.test(sha));
    assert.equal(urlError(url), null);
  });

  it("does not mind a trailing slash on the base", () => {
    assert.equal(
      firmwareUrl("https://bms.example.com/", "b".repeat(64)),
      firmwareUrl("https://bms.example.com", "b".repeat(64)),
    );
  });

  it("refuses plain HTTP and anything over 255 characters", () => {
    assert.match(urlError("http://bms.example.com/firmware/x.bin") ?? "", /HTTPS/);
    assert.match(urlError(`https://${"h".repeat(240)}/firmware/x.bin`) ?? "", /255/);
  });
});

describe("firmware uploads", () => {
  it("accepts an image that starts with the ESP32 magic byte", () => {
    assert.equal(imageError(image()), null);
  });

  it("catches the wrong file before a pack erases a partition for it", () => {
    assert.match(imageError(image(200_000, 0x7f)) ?? "", /0xe9/);
    assert.match(imageError(image(1_000)) ?? "", /too small/);
    assert.match(imageError(image(IMAGE_MAX_BYTES + 1)) ?? "", /will not fit/);
  });
});

describe("OTA status messages", () => {
  it("reads what the firmware publishes", () => {
    const s = parseOtaStatus({
      device_uid: "aabbccddeeff",
      status: "downloading",
      version: "1.1.0",
      message: "HTTPS firmware download started",
      current_version: "1.0.0",
    });
    assert.deepEqual(s, {
      deviceUid: "AABBCCDDEEFF",
      phase: "downloading",
      version: "1.1.0",
      currentVersion: "1.0.0",
      message: "HTTPS firmware download started",
    });
  });

  it("maps the phases the device can report", () => {
    const phase = (status: string) => parseOtaStatus({ status }).phase;
    assert.equal(phase("installed"), "installed");
    assert.equal(phase("failed"), "failed");
    assert.equal(phase("rejected"), "rejected");
    assert.equal(phase("INSTALLING"), "downloading");
    assert.equal(phase("whatever"), null);
  });

  it("keeps the reason a device gives for refusing", () => {
    // The one rejection the firmware does publish: an unconfigured CA.
    const s = parseOtaStatus({
      device_uid: "AABBCCDDEEFF",
      status: "rejected",
      message: "OTA root CA is not configured in include/otaCredentials.h",
    });
    assert.equal(s.phase, "rejected");
    assert.match(s.message ?? "", /otaCredentials\.h/);
  });

  it("gives up nothing on junk", () => {
    for (const junk of [null, "x", 7, [], { device_uid: "nope" }]) {
      const s = parseOtaStatus(junk);
      assert.equal(s.phase, null);
      assert.equal(s.deviceUid, null);
    }
  });
});
