import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type CellStat, diagnose, type DiagnosisWindow, isDiagnosable } from "../lib/diagnose.ts";

const T1 = Date.UTC(2026, 10, 19, 6, 0, 0);
const T0 = T1 - 24 * 3600_000;

/** A healthy 16S window; every test bends one thing out of shape. */
function window(over: Partial<DiagnosisWindow> = {}): DiagnosisWindow {
  const cells: CellStat[] = Array.from({ length: 16 }, (_, i) => ({
    index: i + 1,
    meanMv: 3250,
    minMv: 3180,
    maxMv: 3330,
    lowestCount: 90,
    highestCount: 90,
    zeroCount: 0,
  }));
  return {
    packId: "EM_PACK_16S_03",
    from: T0,
    to: T1,
    readings: 8600,
    samples: 1440,
    seriesCount: 16,
    voltage: { min: 51, max: 54.2, avg: 52.4 },
    current: { min: -40, max: 20, avg: -6 },
    soc: { min: 35, max: 92, avg: 64 },
    spreadMv: { min: 8, max: 40, avg: 18 },
    tempMaxC: { min: 26, max: 34, avg: 30 },
    cells,
    moduleTemps: [
      { index: 1, avgC: 30, maxC: 33 },
      { index: 2, avgC: 31, maxC: 34 },
      { index: 3, avgC: 30, maxC: 33 },
      { index: 4, avgC: 30, maxC: 33 },
    ],
    spreadAtHighCurrentMv: 20,
    spreadAtLowCurrentMv: 16,
    spreadAtHighSocMv: 20,
    spreadAtLowSocMv: 18,
    tempAtHighCurrentC: 31,
    tempAtLowCurrentC: 30,
    tempSlopeCPerHour: 0.1,
    episodes: 1,
    firstSeen: null,
    baseline: { days: 7, spreadAvgMv: 17, tempMaxC: 33 },
    gaps: 0,
    ...over,
  };
}

/** Makes one cell the extreme, without it dominating the sample counts. */
function withOutlier(end: "low" | "high", index: number, mv: number): CellStat[] {
  return window().cells.map((c) =>
    c.index === index ? { ...c, ...(end === "low" ? { minMv: mv } : { maxMv: mv }) } : c,
  );
}

const all = (d: { causes: string[]; actions: string[]; summary: string }) =>
  [d.summary, ...d.causes, ...d.actions].join(" ");

describe("isDiagnosable", () => {
  it("covers battery conditions only", () => {
    assert.ok(isDiagnosable("alarm:over_temperature"));
    assert.ok(isDiagnosable("cell:spread"));
    assert.ok(!isDiagnosable("offline"));
    assert.ok(!isDiagnosable("system:mqtt"));
  });
});

describe("over-temperature", () => {
  it("names a single hot channel as localised", () => {
    const d = diagnose(
      "alarm:over_temperature",
      window({
        moduleTemps: [
          { index: 1, avgC: 31, maxC: 34 },
          { index: 2, avgC: 30, maxC: 33 },
          { index: 3, avgC: 44, maxC: 48 },
          { index: 4, avgC: 31, maxC: 34 },
        ],
        tempMaxC: { min: 30, max: 48, avg: 38 },
      }),
    );
    assert.equal(d.confidence, "likely");
    assert.match(d.summary, /#3/);
    assert.match(d.summary, /localised/);
    assert.match(all(d), /busbar|torque/i);
  });

  it("calls it load-driven when temperature tracks current", () => {
    const d = diagnose(
      "alarm:over_temperature",
      window({ tempAtHighCurrentC: 46, tempAtLowCurrentC: 32, tempMaxC: { min: 30, max: 49, avg: 38 } }),
    );
    assert.equal(d.confidence, "likely");
    assert.match(d.summary, /tracks load/i);
    assert.match(all(d), /C-rate|airflow|derate/i);
  });

  it("falls back to ambient when every channel is warm together", () => {
    const d = diagnose(
      "alarm:over_temperature",
      window({
        moduleTemps: [
          { index: 1, avgC: 45, maxC: 47 },
          { index: 2, avgC: 46, maxC: 48 },
          { index: 3, avgC: 45, maxC: 47 },
          { index: 4, avgC: 46, maxC: 48 },
        ],
        tempMaxC: { min: 43, max: 48, avg: 45 },
      }),
    );
    assert.match(all(d), /ambient|ventilation/i);
  });
});

describe("over-charge", () => {
  it("blames a low-capacity cell when the spread opens near full", () => {
    const d = diagnose(
      "alarm:over_charge",
      window({
        cells: withOutlier("high", 12, 3680),
        spreadAtHighSocMv: 120,
        spreadAtLowSocMv: 20,
        soc: { min: 40, max: 99, avg: 70 },
      }),
    );
    assert.equal(d.confidence, "likely");
    assert.match(d.summary, /#12/);
    assert.match(all(d), /capacity/i);
  });

  it("blames the charger when the whole string rises together", () => {
    const d = diagnose("alarm:over_charge", window({ voltage: { min: 52, max: 59.5, avg: 55 } }));
    assert.match(all(d), /setpoint|cut-off/i);
    assert.match(all(d), /3\.65|58\.4/);
  });
});

describe("over-discharge", () => {
  it("separates resistance from capacity using the load correlation", () => {
    const resistive = diagnose(
      "alarm:over_discharge",
      window({
        cells: withOutlier("low", 7, 2870),
        spreadAtHighCurrentMv: 160,
        spreadAtLowCurrentMv: 10,
        current: { min: -80, max: 10, avg: -20 },
      }),
    );
    assert.equal(resistive.confidence, "likely");
    assert.match(resistive.summary, /#7/);
    assert.match(resistive.summary, /resistance/i);
    assert.match(all(resistive), /torque|busbar|interconnect/i);

    const capacity = diagnose("alarm:over_discharge", window({ cells: withOutlier("low", 7, 2870) }));
    assert.match(capacity.summary, /#7/);
    assert.match(all(capacity), /capacity-test/i);
    assert.doesNotMatch(capacity.summary, /resistance/i);
  });

  it("blames the load when no cell stands out", () => {
    const d = diagnose("alarm:over_discharge", window({ soc: { min: 6, max: 80, avg: 40 } }));
    assert.match(all(d), /knee|low-SOC/i);
  });
});

describe("over-current", () => {
  it("treats a repeat pattern differently from a one-off", () => {
    const repeat = diagnose("alarm:over_current", window({ episodes: 6, current: { min: -180, max: 10, avg: -20 } }));
    assert.equal(repeat.confidence, "likely");
    assert.match(repeat.summary, /6 over-current/);
    assert.match(all(repeat), /switches on|soft starter|stagger/i);

    const once = diagnose("alarm:over_current", window({ episodes: 1, current: { min: -180, max: 10, avg: -20 } }));
    assert.match(all(once), /inrush/i);
  });
});

describe("silent cells", () => {
  it("reads an intermittent zero as a sense lead", () => {
    const cells = window().cells.map((c) => (c.index === 4 ? { ...c, zeroCount: 500 } : c));
    const d = diagnose("cell:silent", window({ cells }));
    assert.match(d.summary, /#4/);
    assert.match(d.summary, /intermittent/i);
    assert.match(all(d), /reseat|crimp|connector/i);
  });

  it("reads a permanent zero as an open lead or dead channel, and flags adjacency", () => {
    const cells = window().cells.map((c) => ([9, 10].includes(c.index) ? { ...c, zeroCount: 1440 } : c));
    const d = diagnose("cell:silent", window({ cells }));
    assert.match(d.summary, /#9/);
    assert.match(all(d), /adjacent|connector block|continuity/i);
    assert.match(all(d), /unmonitored/i);
  });

  it("says so when the BMS flagged a string error but no cell read zero", () => {
    const d = diagnose("alarm:cell_string_error", window());
    assert.equal(d.confidence, "unclear");
    assert.match(all(d), /event log|comms|communication/i);
  });
});

describe("cell spread", () => {
  it("calls a load-dependent spread a resistance problem", () => {
    const d = diagnose(
      "cell:spread",
      window({ cells: withOutlier("low", 5, 3100), spreadAtHighCurrentMv: 130, spreadAtLowCurrentMv: 15 }),
    );
    assert.equal(d.confidence, "likely");
    assert.match(d.summary, /#5/);
    assert.match(all(d), /resistance/i);
    assert.match(all(d), /torque/i);
  });

  it("calls an SOC-dependent spread a capacity problem", () => {
    const d = diagnose(
      "cell:spread",
      window({ cells: withOutlier("high", 9, 3500), spreadAtHighSocMv: 110, spreadAtLowSocMv: 20 }),
    );
    assert.match(all(d), /capacity/i);
    assert.match(all(d), /balance/i);
  });

  it("mentions growth against the previous week", () => {
    const d = diagnose("cell:spread", window({ spreadMv: { min: 20, max: 90, avg: 48 }, baseline: { days: 7, spreadAvgMv: 18, tempMaxC: 33 } }));
    assert.match(all(d), /\+30 mV|wider than the previous 7 days/);
  });

  it("suspects balancing when the offset is flat across load and SOC", () => {
    const d = diagnose("cell:spread", window({ spreadMv: { min: 95, max: 110, avg: 100 } }));
    assert.match(all(d), /balancing/i);
  });
});

describe("outlier detection", () => {
  it("finds a cell that only separates under load, without it dominating the samples", () => {
    const d = diagnose(
      "alarm:over_discharge",
      window({
        cells: withOutlier("low", 7, 2870),
        spreadAtHighCurrentMv: 160,
        spreadAtLowCurrentMv: 10,
      }),
    );
    // Every cell has the same lowestCount, so only the separation test can find #7.
    assert.match(d.summary, /#7/);
  });

  it("ignores a cell whose readings are missing, so a sense fault is not read as a weak cell", () => {
    const cells = window().cells.map((c) => (c.index === 4 ? { ...c, zeroCount: 700, minMv: 0, meanMv: 0 } : c));
    const d = diagnose("alarm:over_discharge", window({ cells }));
    assert.doesNotMatch(d.summary, /#4/);
  });
});

describe("thin data", () => {
  it("declines to analyse a pack with almost no history", () => {
    const d = diagnose("alarm:over_temperature", window({ readings: 12 }));
    assert.equal(d.confidence, "unclear");
    assert.match(d.summary, /too little history/i);
    assert.equal(d.causes.length, 1);
  });
});

describe("flapping", () => {
  it("describes a continuously toggling condition as flapping rather than counting events", () => {
    const cells = window().cells.map((c) => (c.index === 4 ? { ...c, zeroCount: 500 } : c));
    const d = diagnose("cell:silent", window({ cells, episodes: 2075 }));
    const f = d.findings.find((x) => x.label === "Pattern");
    assert.ok(f, "expected a Pattern finding");
    assert.equal(f.value, "Flapping");
  });
});

describe("summary length", () => {
  it("stays inside the WhatsApp variable budget for every condition", () => {
    const cases: [string, DiagnosisWindow][] = [
      ["alarm:over_temperature", window({ moduleTemps: [{ index: 1, avgC: 50, maxC: 55 }, { index: 2, avgC: 30, maxC: 33 }, { index: 3, avgC: 31, maxC: 34 }] })],
      ["alarm:over_charge", window({ cells: withOutlier("high", 12, 3700), spreadAtHighSocMv: 120, spreadAtLowSocMv: 20 })],
      ["alarm:over_discharge", window({ cells: withOutlier("low", 7, 2870), spreadAtHighCurrentMv: 160, spreadAtLowCurrentMv: 10 })],
      ["alarm:over_current", window({ episodes: 6 })],
      ["cell:silent", window({ cells: window().cells.map((c) => (c.index === 4 ? { ...c, zeroCount: 500 } : c)) })],
      ["cell:spread", window({ spreadAtHighCurrentMv: 130, spreadAtLowCurrentMv: 15 })],
    ];
    for (const [cond, w] of cases) {
      const d = diagnose(cond, w);
      assert.ok(d.summary.length <= 200, `${cond}: ${d.summary.length} chars — ${d.summary}`);
      assert.doesNotMatch(d.summary, /[\r\n\t]/, `${cond} has a line break, which Meta rejects in a variable`);
    }
  });
});
