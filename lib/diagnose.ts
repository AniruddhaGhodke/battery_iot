/**
 * Cause analysis for a battery alert, from the pack's last 24 hours.
 *
 * Pure functions over a DiagnosisWindow (gathered by ingest/diagnose-data.ts),
 * so every rule is testable with made-up data and the same code can describe
 * a reading on the dashboard.
 *
 * The rules are deliberately conservative: they report what the data shows and
 * rank the causes that fit it. Where the data cannot separate two causes they
 * say so rather than guessing. Nothing here replaces looking at the pack.
 */

export type Stat = {
  min: number | null;
  max: number | null;
  avg: number | null;
};

export type CellStat = {
  /** 1-based position in the string. */
  index: number;
  meanMv: number;
  minMv: number;
  maxMv: number;
  /** Samples where this cell was the lowest in the string. */
  lowestCount: number;
  /** Samples where it was the highest. */
  highestCount: number;
  /** Samples where it read 0 V. */
  zeroCount: number;
};

export type ModuleTemp = {
  /** 1-based channel number. */
  index: number;
  avgC: number;
  maxC: number;
};

export type DiagnosisWindow = {
  packId: string;
  from: number;
  to: number;
  /** Readings stored in the window. */
  readings: number;
  /** Rows actually sampled for the per-cell figures (1/minute). */
  samples: number;
  seriesCount: number;

  voltage: Stat;
  /** Negative = discharge, as the device reports it. */
  current: Stat;
  soc: Stat;
  spreadMv: Stat;
  tempMaxC: Stat;

  cells: CellStat[];
  moduleTemps: ModuleTemp[];

  /** Mean spread when |current| was in its top / bottom quartile, mV. */
  spreadAtHighCurrentMv: number | null;
  spreadAtLowCurrentMv: number | null;
  /** Mean spread above 85 % SOC and below 25 % SOC, mV. */
  spreadAtHighSocMv: number | null;
  spreadAtLowSocMv: number | null;
  /** Mean peak temperature in the same two current quartiles, degC. */
  tempAtHighCurrentC: number | null;
  tempAtLowCurrentC: number | null;
  /** Least-squares slope of peak temperature over the last 3 h, degC/hour. */
  tempSlopeCPerHour: number | null;

  /** Separate episodes of this condition inside the window. */
  episodes: number;
  /** First time the condition was true in the window. */
  firstSeen: number | null;

  /** The 7 days before this window, from the hourly roll-up. */
  baseline: { days: number; spreadAvgMv: number | null; tempMaxC: number | null } | null;

  /** Gaps longer than 5 minutes between readings: the pack dropping out. */
  gaps: number;
};

export type Finding = { label: string; value: string; note?: string };

export type Diagnosis = {
  condition: string;
  /** One line for the WhatsApp message. Kept short on purpose. */
  summary: string;
  /** How well the data separates the causes below. */
  confidence: "likely" | "possible" | "unclear";
  /** What the 24 h of data shows. */
  findings: Finding[];
  /** Ranked, most probable first. */
  causes: string[];
  /** What to check or do, in order. */
  actions: string[];
  window: { from: number; to: number; readings: number };
};

const LFP_CELL_MAX_MV = 3650;
const LFP_CELL_MIN_MV = 2500;

/** A hot channel this far above the median is localised, not ambient. */
const HOTSPOT_C = 5;
/** Temperature difference between load quartiles that counts as load-driven. */
const LOAD_TEMP_C = 4;
/** Spread difference between load quartiles that counts as resistance-driven. */
const LOAD_SPREAD_MV = 20;
/** Spread difference between SOC bands that counts as capacity-driven. */
const SOC_SPREAD_MV = 25;

const n1 = (v: number | null | undefined, dp = 1) =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(dp);

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Hours covered by the window. */
function hours(w: DiagnosisWindow): number {
  return Math.max(0, (w.to - w.from) / 3_600_000);
}

/** The channel furthest above the median channel, when there are enough channels. */
function hotspot(w: DiagnosisWindow): { mod: ModuleTemp; overMedianC: number } | null {
  if (w.moduleTemps.length < 3) return null;
  const med = median(w.moduleTemps.map((m) => m.avgC));
  if (med === null) return null;
  const hottest = w.moduleTemps.reduce((a, b) => (b.avgC > a.avgC ? b : a));
  const over = hottest.avgC - med;
  return over >= HOTSPOT_C ? { mod: hottest, overMedianC: over } : null;
}

/** A cell this far clear of the next one at the extreme is an outlier on its own. */
const OUTLIER_GAP_MV = 30;

/**
 * The cell behind the alert, by either of two signals: it is at the extreme
 * in most samples, or its extreme is clearly separated from the next cell's.
 * The second case matters for a fault that only shows under load — the cell
 * looks ordinary at rest, so it never dominates the sample count.
 *
 * Cells with missing readings are excluded: a 0 V channel is a sense-lead
 * fault (cell:silent covers it), not a cell at a voltage extreme.
 */
function outlier(w: DiagnosisWindow, end: "low" | "high"): { cell: CellStat; share: number } | null {
  const cells = w.cells.filter((c) => c.zeroCount === 0 && c.meanMv > 0);
  if (!cells.length || !w.samples) return null;

  const count = (c: CellStat) => (end === "low" ? c.lowestCount : c.highestCount);
  const top = cells.reduce((a, b) => (count(b) > count(a) ? b : a));
  if (count(top) / w.samples >= 0.6) return { cell: top, share: count(top) / w.samples };

  if (cells.length < 3) return null;
  const sorted = [...cells].sort((a, b) => (end === "low" ? a.minMv - b.minMv : b.maxMv - a.maxMv));
  const gap = end === "low" ? sorted[1].minMv - sorted[0].minMv : sorted[0].maxMv - sorted[1].maxMv;
  if (gap < OUTLIER_GAP_MV) return null;
  return { cell: sorted[0], share: count(sorted[0]) / w.samples };
}

/**
 * How we know this cell is the outlier. A cell found by separation rather
 * than by dominating the samples is described that way, because "lowest in
 * 30 % of samples" reads like weak evidence when it is in fact the signature
 * of a load-dependent fault.
 */
function evidence(o: { cell: CellStat; share: number }, end: "low" | "high"): string {
  const mv = end === "low" ? o.cell.minMv : o.cell.maxMv;
  return o.share >= 0.6
    ? `the ${end === "low" ? "lowest" : "highest"} cell in ${Math.round(o.share * 100)} % of samples, reaching ${mv} mV`
    : `clear of every other cell at the ${end === "low" ? "bottom" : "top"} of its range (${mv} mV), though only for part of the window`;
}

const FLAPPING = 50;

function episodeNote(w: DiagnosisWindow): Finding | null {
  if (w.episodes <= 1) return null;
  if (w.episodes >= FLAPPING) {
    return {
      label: "Pattern",
      value: "Flapping",
      note: `Switched on and off ${w.episodes} times in 24 h — effectively continuous, not a series of separate events.`,
    };
  }
  return {
    label: "Episodes in 24 h",
    value: String(w.episodes),
    note: "Recurring, not a one-off — look for something that switches on and off.",
  };
}

function windowFindings(w: DiagnosisWindow): Finding[] {
  const f: Finding[] = [];
  // The report header already states the window, so only mention it when
  // there is something wrong with it.
  if (w.gaps > 0) {
    f.push({
      label: "Data gaps",
      value: `${w.gaps} over 5 min`,
      note: "The pack stopped reporting during the window, so the picture is incomplete.",
    });
  }
  const e = episodeNote(w);
  if (e) f.push(e);
  return f;
}

/** Not enough data to say anything useful. */
function thin(condition: string, w: DiagnosisWindow): Diagnosis | null {
  if (w.readings >= 60) return null;
  return {
    condition,
    summary: `Only ${w.readings} readings in the last 24 h — too little history to analyse.`,
    confidence: "unclear",
    findings: windowFindings(w),
    causes: ["Not enough stored data for this pack yet."],
    actions: ["Check the alert again once the pack has been reporting for a few hours."],
    window: { from: w.from, to: w.to, readings: w.readings },
  };
}

function overTemperature(w: DiagnosisWindow): Diagnosis {
  const findings = windowFindings(w);
  const causes: string[] = [];
  const actions: string[] = [];
  let confidence: Diagnosis["confidence"] = "possible";
  let summary: string;

  const spot = hotspot(w);
  const loadDelta =
    w.tempAtHighCurrentC !== null && w.tempAtLowCurrentC !== null
      ? w.tempAtHighCurrentC - w.tempAtLowCurrentC
      : null;
  const loadDriven = loadDelta !== null && loadDelta >= LOAD_TEMP_C;
  const peakCurrent = Math.max(Math.abs(w.current.min ?? 0), Math.abs(w.current.max ?? 0));

  findings.push({
    label: "Peak temperature",
    value: `${n1(w.tempMaxC.max)} °C`,
    note: `24 h mean ${n1(w.tempMaxC.avg)} °C`,
  });
  if (w.moduleTemps.length) {
    findings.push({
      label: "By channel",
      value: w.moduleTemps.map((m) => `#${m.index} ${n1(m.avgC, 0)}°`).join(", "),
      note: "24 h average per temperature channel.",
    });
  }
  if (loadDelta !== null) {
    findings.push({
      label: "Load correlation",
      value: `${loadDelta >= 0 ? "+" : ""}${n1(loadDelta)} °C at high current`,
      note: `Peak |current| ${n1(peakCurrent)} A.`,
    });
  }
  if (w.tempSlopeCPerHour !== null) {
    findings.push({ label: "Trend (last 3 h)", value: `${n1(w.tempSlopeCPerHour, 2)} °C/h` });
  }
  if (w.baseline?.tempMaxC != null && w.tempMaxC.max != null) {
    const over = w.tempMaxC.max - w.baseline.tempMaxC;
    findings.push({
      label: `vs previous ${w.baseline.days} days`,
      value: `${over >= 0 ? "+" : ""}${n1(over)} °C on the peak`,
    });
  }

  if (spot) {
    confidence = "likely";
    summary = `Channel #${spot.mod.index} runs ${n1(spot.overMedianC)} °C above the other channels — localised heating, not ambient.`;
    causes.push(
      `Localised heat at temperature channel #${spot.mod.index} (${n1(spot.mod.avgC)} °C average, ${n1(spot.overMedianC)} °C above the median channel). A single hot point is usually a high-resistance joint — a loose or corroded busbar bolt or terminal — rather than a cell fault.`,
      "A weak or high-resistance cell in that module, which dissipates more heat than its neighbours at the same current.",
    );
    actions.push(
      `Inspect the interconnects around channel #${spot.mod.index} under load: thermal camera if you have one, otherwise check for discolouration and re-torque the busbar bolts to spec.`,
      `Compare that module's cell voltages under load against the rest of the string — a cell sagging more than its neighbours points at the cell rather than the joint.`,
    );
  } else if (loadDriven) {
    confidence = "likely";
    summary = `Temperature tracks load: ${n1(loadDelta)} °C hotter at high current, peak ${n1(peakCurrent)} A. Thermal rise is duty-cycle driven.`;
    causes.push(
      `Heating follows the current draw (${n1(loadDelta)} °C hotter in the top current quartile, peak ${n1(peakCurrent)} A). The pack is being worked harder than it can shed heat.`,
      "Insufficient airflow for this duty cycle — fans not running, filters blocked, or the enclosure undersized.",
    );
    actions.push(
      `Check the duty cycle against the pack's continuous C-rate; peak was ${n1(peakCurrent)} A.`,
      "Verify fans and air paths are clear, and that intake air isn't recirculating hot exhaust.",
      "If the load is as designed, derate the continuous current or improve cooling.",
    );
  } else {
    const spread = w.moduleTemps.length
      ? Math.max(...w.moduleTemps.map((m) => m.avgC)) - Math.min(...w.moduleTemps.map((m) => m.avgC))
      : null;
    summary = `Whole pack warm (peak ${n1(w.tempMaxC.max)} °C), no single hot channel and no clear load correlation — points at ambient or ventilation.`;
    causes.push(
      `All channels are within ${n1(spread)} °C of each other, so the heat is going in evenly — ambient temperature or enclosure ventilation rather than a fault in the pack.`,
      "A cooling system that has stopped — fan failure, blocked intake, or a door left shut on a vented enclosure.",
    );
    actions.push(
      "Measure the ambient temperature at the enclosure intake and compare it with the pack's rated operating range.",
      "Check that fans run and that intake and exhaust are clear.",
      "If ambient is within range and airflow is fine, re-check the temperature sensor calibration before treating this as a real excursion.",
    );
  }

  return { condition: "alarm:over_temperature", summary, confidence, findings, causes, actions, window: win(w) };
}

function overCharge(w: DiagnosisWindow): Diagnosis {
  const findings = windowFindings(w);
  const causes: string[] = [];
  const actions: string[] = [];
  let confidence: Diagnosis["confidence"] = "possible";
  let summary: string;

  const high = outlier(w, "high");
  const maxCell = w.cells.length ? w.cells.reduce((a, b) => (b.maxMv > a.maxMv ? b : a)) : null;
  const meanMv = w.cells.length ? w.cells.reduce((s, c) => s + c.meanMv, 0) / w.cells.length : null;

  findings.push({
    label: "Pack voltage",
    value: `${n1(w.voltage.max)} V peak`,
    note: `SOC reached ${n1(w.soc.max, 0)} %`,
  });
  if (maxCell) {
    findings.push({
      label: "Highest cell",
      value: `#${maxCell.index} at ${maxCell.maxMv} mV`,
      note: `String mean ${n1(meanMv, 0)} mV, LFP limit ${LFP_CELL_MAX_MV} mV.`,
    });
  }
  if (w.spreadAtHighSocMv !== null) {
    findings.push({
      label: "Spread above 85 % SOC",
      value: `${n1(w.spreadAtHighSocMv, 0)} mV`,
      note: w.spreadAtLowSocMv !== null ? `${n1(w.spreadAtLowSocMv, 0)} mV below 25 % SOC.` : undefined,
    });
  }

  const topHeavy =
    w.spreadAtHighSocMv !== null &&
    w.spreadAtLowSocMv !== null &&
    w.spreadAtHighSocMv - w.spreadAtLowSocMv >= SOC_SPREAD_MV;

  if (high && topHeavy) {
    confidence = "likely";
    summary = `Cell #${high.cell.index} tops out first (${high.cell.maxMv} mV) and the spread widens to ${n1(w.spreadAtHighSocMv, 0)} mV near full — reduced capacity on that cell.`;
    causes.push(
      `Cell #${high.cell.index} is ${evidence(high, "high")}. The spread widens from ${n1(w.spreadAtLowSocMv, 0)} mV at low SOC to ${n1(w.spreadAtHighSocMv, 0)} mV near full, which is the signature of a cell with less usable capacity: it fills before the others and runs away at the top.`,
      "Balancing current too small to close the gap within a charge cycle, so the imbalance compounds over cycles.",
    );
    actions.push(
      `Hold the pack at the top of charge and let the BMS balance; watch whether cell #${high.cell.index} comes back toward the string mean.`,
      `If the gap persists over several cycles, capacity-test cell #${high.cell.index} against a known-good cell.`,
      `Until it is resolved, lower the charge cut-off so cell #${high.cell.index} stays under ${LFP_CELL_MAX_MV} mV.`,
    );
  } else if (high) {
    summary = `Cell #${high.cell.index} reached ${high.cell.maxMv} mV against a string mean of ${n1(meanMv, 0)} mV — single-cell overvoltage.`;
    causes.push(
      `Cell #${high.cell.index} is ${evidence(high, "high")}. Either it holds less charge than the rest, or its balancing channel is not working.`,
      "A sense-lead or connection problem reading high on that channel, rather than a real cell difference.",
    );
    actions.push(
      `Measure cell #${high.cell.index} directly with a meter and compare against what the BMS reports — that separates a real overvoltage from a sense-lead error.`,
      "Confirm the balancing channel for that cell actually operates at the top of charge.",
    );
  } else {
    summary = `All cells rose together to about ${n1(meanMv, 0)} mV (peak ${n1(w.voltage.max)} V) — charge cut-off is set too high.`;
    causes.push(
      `No single cell stands out; the whole string reached roughly ${n1(meanMv, 0)} mV. That points at the charge source rather than the pack: the CV setpoint is above what the cells should see.`,
      "A charger that does not taper properly at the end of CV, or whose voltage sense is off.",
    );
    actions.push(
      `Check the charger or inverter CV setpoint against ${w.seriesCount} × ${LFP_CELL_MAX_MV / 1000} V = ${n1((w.seriesCount * LFP_CELL_MAX_MV) / 1000)} V for LFP, and set it a little below.`,
      "Verify the charger's voltage sensing at the pack terminals, not at its own output.",
    );
  }

  return { condition: "alarm:over_charge", summary, confidence, findings, causes, actions, window: win(w) };
}

function overDischarge(w: DiagnosisWindow): Diagnosis {
  const findings = windowFindings(w);
  const causes: string[] = [];
  const actions: string[] = [];
  let confidence: Diagnosis["confidence"] = "possible";
  let summary: string;

  const low = outlier(w, "low");
  const minCell = w.cells.length ? w.cells.reduce((a, b) => (b.minMv < a.minMv ? b : a)) : null;
  const meanMv = w.cells.length ? w.cells.reduce((s, c) => s + c.meanMv, 0) / w.cells.length : null;
  const peakDischarge = Math.abs(Math.min(w.current.min ?? 0, 0));

  findings.push({
    label: "Pack voltage",
    value: `${n1(w.voltage.min)} V low`,
    note: `SOC fell to ${n1(w.soc.min, 0)} %, peak discharge ${n1(peakDischarge)} A.`,
  });
  if (minCell) {
    findings.push({
      label: "Lowest cell",
      value: `#${minCell.index} at ${minCell.minMv} mV`,
      note: `String mean ${n1(meanMv, 0)} mV, LFP knee near ${LFP_CELL_MIN_MV} mV.`,
    });
  }
  const loadSpread =
    w.spreadAtHighCurrentMv !== null && w.spreadAtLowCurrentMv !== null
      ? w.spreadAtHighCurrentMv - w.spreadAtLowCurrentMv
      : null;
  if (loadSpread !== null) {
    findings.push({
      label: "Spread under load",
      value: `${n1(w.spreadAtHighCurrentMv, 0)} mV at high current`,
      note: `${n1(w.spreadAtLowCurrentMv, 0)} mV at rest — a difference of ${n1(loadSpread, 0)} mV.`,
    });
  }

  const resistive = loadSpread !== null && loadSpread >= LOAD_SPREAD_MV;

  if (low && resistive) {
    confidence = "likely";
    summary = `Cell #${low.cell.index} sags to ${low.cell.minMv} mV under ${n1(peakDischarge)} A while the string holds ${n1(meanMv, 0)} mV — high internal resistance.`;
    causes.push(
      `Cell #${low.cell.index} is ${evidence(low, "low")}. The spread grows by ${n1(loadSpread, 0)} mV between rest and high current, so the cell is sagging under load rather than being genuinely emptier — that is resistance, in the cell or in its connection.`,
      "A loose or corroded interconnect at that cell, which looks identical to cell resistance from the BMS's point of view.",
    );
    actions.push(
      `Re-torque and inspect the busbar either side of cell #${low.cell.index} first — a bad joint is the cheaper and more common fault.`,
      `If the joints are sound, measure that cell's internal resistance against a neighbour at the same current.`,
      "Until it is sorted, raise the low-voltage cut-off so the weak cell doesn't get pulled below the knee.",
    );
  } else if (low) {
    summary = `Cell #${low.cell.index} reached ${low.cell.minMv} mV against a string mean of ${n1(meanMv, 0)} mV — that cell empties first.`;
    causes.push(
      `Cell #${low.cell.index} is ${evidence(low, "low")}. With no strong load correlation this looks like less usable capacity rather than resistance.`,
      "Imbalance that balancing has not closed, so this cell starts each discharge lower than the rest.",
    );
    actions.push(
      `Capacity-test cell #${low.cell.index} against a known-good cell.`,
      "Check that balancing is actually operating, and let the pack sit at the top of charge for a full balance cycle.",
    );
  } else {
    summary = `Pack-wide sag to ${n1(w.voltage.min)} V at ${n1(peakDischarge)} A with SOC down to ${n1(w.soc.min, 0)} % — load applied at low state of charge.`;
    causes.push(
      `No single cell stands out — the whole string fell together with SOC at ${n1(w.soc.min, 0)} %. The pack was simply discharged into the knee of the LFP curve, where voltage drops steeply for very little remaining energy.`,
      `A load larger than the pack is sized for at low SOC (peak ${n1(peakDischarge)} A).`,
    );
    actions.push(
      "Raise the low-SOC cut-off so the load drops out before the voltage knee.",
      "Check the load profile against the pack's rating, especially any surge at the end of discharge.",
    );
  }

  return { condition: "alarm:over_discharge", summary, confidence, findings, causes, actions, window: win(w) };
}

function overCurrent(w: DiagnosisWindow): Diagnosis {
  const findings = windowFindings(w);
  const peakDischarge = Math.abs(Math.min(w.current.min ?? 0, 0));
  const peakCharge = Math.max(w.current.max ?? 0, 0);
  const discharging = peakDischarge >= peakCharge;
  const peak = discharging ? peakDischarge : peakCharge;
  const causes: string[] = [];
  const actions: string[] = [];

  findings.push({
    label: "Peak current",
    value: `${n1(peak)} A ${discharging ? "discharge" : "charge"}`,
    note: `24 h mean ${n1(w.current.avg)} A.`,
  });

  const repeating = w.episodes >= 3;
  const summary = repeating
    ? `${w.episodes} over-current episodes in 24 h, peak ${n1(peak)} A ${discharging ? "discharge" : "charge"} — a recurring load, not a one-off.`
    : `Peak ${n1(peak)} A ${discharging ? "discharge" : "charge"} against the BMS limit — ${w.episodes <= 1 ? "a single episode" : `${w.episodes} episodes`} in 24 h.`;

  if (repeating) {
    causes.push(
      `The trip repeated ${w.episodes} times in 24 h, so something on the system switches on and draws more than the limit — a motor start, a compressor, or several loads coinciding.`,
      "A BMS current limit set below what the installation actually needs.",
    );
    actions.push(
      "Line the alert times up against what switches on at the site — the repeat interval usually names the culprit.",
      "If the load is legitimate, stagger the starts or fit a soft starter.",
      "Only after that, review whether the BMS limit matches the pack's real continuous and peak ratings.",
    );
  } else {
    causes.push(
      `A single excursion to ${n1(peak)} A. Most often inrush — a load starting into a cold motor or a capacitive input.`,
      "A fault on the load side: a short, a stalled motor, or an inverter fault.",
    );
    actions.push(
      "Check what was running at the time, and whether it had just started.",
      "Inspect the load wiring for damage or a short if nothing was switching on.",
    );
  }

  return {
    condition: "alarm:over_current",
    summary,
    confidence: repeating ? "likely" : "possible",
    findings,
    causes,
    actions,
    window: win(w),
  };
}

function silentCells(w: DiagnosisWindow, condition: string): Diagnosis {
  const findings = windowFindings(w);
  const affected = w.cells.filter((c) => c.zeroCount > 0).sort((a, b) => b.zeroCount - a.zeroCount);
  const causes: string[] = [];
  const actions: string[] = [];

  if (!affected.length) {
    return {
      condition,
      summary: "The BMS reported a string error, but no cell read 0 V in the last 24 h.",
      confidence: "unclear",
      findings,
      causes: [
        "The fault cleared before the window, or the BMS raised the flag for a reason it does not expose in the payload (an internal self-test, a comms error between master and slave boards).",
      ],
      actions: [
        "Check the BMS's own event log — it will have a reason code the telemetry doesn't carry.",
        "Check the master-to-slave communication wiring if the pack uses separate slave boards.",
      ],
      window: win(w),
    };
  }

  const positions = affected.map((c) => `#${c.index}`).join(", ");
  const worst = affected[0];
  const share = w.samples ? worst.zeroCount / w.samples : 0;
  const intermittent = share < 0.9;
  const adjacent =
    affected.length > 1 &&
    affected
      .map((c) => c.index)
      .sort((a, b) => a - b)
      .every((v, i, arr) => i === 0 || v === arr[i - 1] + 1);

  findings.push({
    label: "Cells reading 0 V",
    value: positions,
    note: `${worst.zeroCount} of ${w.samples} samples on the worst (#${worst.index}).`,
  });

  const summary = intermittent
    ? `Cell ${positions} drops out intermittently (${Math.round(share * 100)} % of samples) — loose sense lead rather than a dead cell.`
    : `Cell ${positions} reads 0 V continuously — disconnected sense lead or a dead BMS channel.`;

  if (intermittent) {
    causes.push(
      `The reading comes and goes (${Math.round(share * 100)} % of samples at 0 V). A cell does not behave like that — this is a sense lead making and breaking contact, usually at the connector or a crimp.`,
      "Vibration or thermal cycling working a connector loose.",
    );
    actions.push(
      `Reseat the sense harness connector covering cell ${positions}, and check the crimp at the cell terminal.`,
      "Wiggle-test the harness while watching the live reading — it will flick to 0 V at the bad joint.",
    );
  } else {
    causes.push(
      adjacent
        ? `Cells ${positions} are adjacent and all read 0 V, which points at one connector block or a broken section of the sense harness rather than several independent faults.`
        : `Cell ${positions} reads 0 V in every sample — the sense lead is open circuit, or the BMS input for that channel has failed.`,
      "A genuinely dead cell is possible but much less likely: a failed cell usually reads low, not exactly zero.",
    );
    actions.push(
      `Continuity-check the sense lead for cell ${positions} from the BMS connector to the cell terminal.`,
      `Measure cell ${positions} directly with a meter — if it reads normally, the fault is the lead or the BMS input, not the cell.`,
      "If the lead is good, move that cell's lead to a spare BMS channel to tell an input failure from a wiring fault.",
    );
  }

  actions.push("Treat the affected cells as unmonitored until this is fixed — over-charge and over-discharge protection is blind on those positions.");

  return { condition, summary, confidence: "likely", findings, causes, actions, window: win(w) };
}

function cellSpread(w: DiagnosisWindow): Diagnosis {
  const findings = windowFindings(w);
  const causes: string[] = [];
  const actions: string[] = [];
  let confidence: Diagnosis["confidence"] = "possible";

  const low = outlier(w, "low");
  const high = outlier(w, "high");
  const loadSpread =
    w.spreadAtHighCurrentMv !== null && w.spreadAtLowCurrentMv !== null
      ? w.spreadAtHighCurrentMv - w.spreadAtLowCurrentMv
      : null;
  const socSpread =
    w.spreadAtHighSocMv !== null && w.spreadAtLowSocMv !== null
      ? Math.abs(w.spreadAtHighSocMv - w.spreadAtLowSocMv)
      : null;

  findings.push({
    label: "Spread",
    value: `${n1(w.spreadMv.max, 0)} mV peak`,
    note: `24 h mean ${n1(w.spreadMv.avg, 0)} mV.`,
  });
  if (low) {
    findings.push({
      label: "Lowest cell",
      value: `#${low.cell.index}`,
      note: `${evidence(low, "low")}; 24 h mean ${n1(low.cell.meanMv, 0)} mV.`,
    });
  }
  if (high) {
    findings.push({
      label: "Highest cell",
      value: `#${high.cell.index}`,
      note: `${evidence(high, "high")}; 24 h mean ${n1(high.cell.meanMv, 0)} mV.`,
    });
  }
  if (loadSpread !== null) {
    findings.push({
      label: "Load dependence",
      value: `${loadSpread >= 0 ? "+" : ""}${n1(loadSpread, 0)} mV at high current`,
    });
  }
  if (socSpread !== null) {
    findings.push({
      label: "SOC dependence",
      value: `${n1(w.spreadAtHighSocMv, 0)} mV high SOC vs ${n1(w.spreadAtLowSocMv, 0)} mV low SOC`,
    });
  }

  let growth: string | null = null;
  if (w.baseline?.spreadAvgMv != null && w.spreadMv.avg != null) {
    const d = w.spreadMv.avg - w.baseline.spreadAvgMv;
    findings.push({
      label: `vs previous ${w.baseline.days} days`,
      value: `${d >= 0 ? "+" : ""}${n1(d, 0)} mV on the mean`,
    });
    if (d >= 10) growth = `The mean spread is ${n1(d, 0)} mV wider than the previous ${w.baseline.days} days, so this is getting worse rather than sitting still.`;
  }

  const who = low ? `#${low.cell.index}` : high ? `#${high.cell.index}` : null;
  let summary: string;

  if (loadSpread !== null && loadSpread >= LOAD_SPREAD_MV) {
    confidence = "likely";
    summary = `Spread opens by ${n1(loadSpread, 0)} mV under load${who ? `, worst at cell ${who}` : ""} — resistance difference, not capacity.`;
    causes.push(
      `The spread is load-dependent: ${n1(w.spreadAtLowCurrentMv, 0)} mV at rest against ${n1(w.spreadAtHighCurrentMv, 0)} mV at high current. That is a resistance difference — a cell or its connection dropping more voltage at the same current — not a difference in stored energy.`,
      who
        ? `A loose, corroded or under-torqued joint at cell ${who}. Connection resistance looks exactly like cell resistance to the BMS.`
        : "A connection problem somewhere in the string, since no single cell dominates.",
    );
    actions.push(
      who
        ? `Inspect and re-torque the busbars either side of cell ${who} before suspecting the cell.`
        : "Work along the string re-torquing busbars; check for discoloured or dull joints.",
      "Re-check the spread at the same current after the work — a joint fix shows up immediately.",
      "If it doesn't improve, measure internal resistance cell by cell at a fixed current.",
    );
  } else if (socSpread !== null && socSpread >= SOC_SPREAD_MV) {
    confidence = "likely";
    const atTop = (w.spreadAtHighSocMv ?? 0) > (w.spreadAtLowSocMv ?? 0);
    summary = `Spread widens ${atTop ? "near full charge" : "at low SOC"} (${n1(Math.max(w.spreadAtHighSocMv ?? 0, w.spreadAtLowSocMv ?? 0), 0)} mV)${who ? `, cell ${who} the outlier` : ""} — capacity mismatch.`;
    causes.push(
      `The spread depends on state of charge rather than current — ${n1(w.spreadAtHighSocMv, 0)} mV above 85 % SOC against ${n1(w.spreadAtLowSocMv, 0)} mV below 25 %. Cells with different usable capacity diverge at the ends of the curve and sit together in the flat middle.`,
      "Balancing that cannot keep up with the mismatch within a cycle.",
    );
    actions.push(
      "Hold the pack at the top of charge long enough for a full balance cycle and see how much closes.",
      who ? `If it reopens, capacity-test cell ${who} — that is the one setting the limit.` : "If it reopens, capacity-test the cells at the extremes of the spread.",
      "Plan on replacing or re-matching the weak cell if the gap keeps growing; mismatched capacity does not recover.",
    );
  } else {
    summary = `Spread sits at ${n1(w.spreadMv.avg, 0)} mV with no clear load or SOC dependence${who ? `, cell ${who} consistently offset` : ""}.`;
    causes.push(
      "The offset is roughly constant across load and state of charge, which usually means balancing is not keeping up, or is not running at all.",
      who ? `A persistent offset on cell ${who} — possibly a sense-lead calibration error rather than a real difference.` : "A slow drift across the string, normal as a pack ages but worth tracking.",
    );
    actions.push(
      "Confirm the BMS balancing is enabled and check its balancing threshold and current.",
      who ? `Meter cell ${who} directly and compare with the BMS reading to rule out a sense error.` : "Spot-check a few cells with a meter against the BMS readings.",
      "Watch the trend over the next week rather than acting immediately if the pack is otherwise healthy.",
    );
  }

  if (growth) causes.unshift(growth);

  return { condition: "cell:spread", summary, confidence, findings, causes, actions, window: win(w) };
}

function win(w: DiagnosisWindow) {
  return { from: w.from, to: w.to, readings: w.readings };
}

/** Conditions worth analysing. Offline and system alerts are not. */
export function isDiagnosable(condition: string): boolean {
  return condition.startsWith("alarm:") || condition.startsWith("cell:");
}

export function diagnose(condition: string, w: DiagnosisWindow): Diagnosis {
  const t = thin(condition, w);
  if (t) return t;
  switch (condition) {
    case "alarm:over_temperature":
      return overTemperature(w);
    case "alarm:over_charge":
      return overCharge(w);
    case "alarm:over_discharge":
      return overDischarge(w);
    case "alarm:over_current":
      return overCurrent(w);
    case "alarm:cell_string_error":
    case "cell:silent":
      return silentCells(w, condition);
    case "cell:spread":
      return cellSpread(w);
    default:
      return {
        condition,
        summary: "No analysis rule for this condition.",
        confidence: "unclear",
        findings: windowFindings(w),
        causes: [],
        actions: [],
        window: win(w),
      };
  }
}
