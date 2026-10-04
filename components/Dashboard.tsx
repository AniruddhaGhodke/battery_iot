"use client";

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import type { History, PackDetail, PackSummary, Point } from "@/lib/data";
import type { Status } from "@/lib/ingest-status";
import { ago, fmt, skew } from "@/lib/format";
import { StatCard } from "./StatCard";
import { Sparkline } from "./Sparkline";
import { CellBars } from "./CellBars";

const POLL_MS = 3000;
const HISTORY_REFRESH_MS = 60_000;
const H = 3_600_000;
const D = 24 * H;

const RANGES = [
  { key: "live", label: "Live", ms: 0 },
  { key: "6h", label: "6 h", ms: 6 * H },
  { key: "24h", label: "24 h", ms: D },
  { key: "7d", label: "7 d", ms: 7 * D },
  { key: "30d", label: "30 d", ms: 30 * D },
  { key: "90d", label: "90 d", ms: 90 * D },
  { key: "1y", label: "1 y", ms: 365 * D },
  { key: "custom", label: "Custom", ms: 0 },
] as const;
type RangeKey = (typeof RANGES)[number]["key"];

const ALARM_LABEL: Record<string, string> = {
  over_current: "Over-current",
  over_discharge: "Over-discharge",
  over_charge: "Over-charge",
  over_temperature: "Over-temperature",
  cell_string_error: "Cell string error",
};

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { cache: "no-store" });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

/** Value for <input type="datetime-local"> in the browser's time zone. */
function toLocalInput(ms: number): string {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

function describeSource(h: History | null): string {
  if (!h) return "last 360 readings";
  if (h.source === "raw") return "every reading";
  const b = h.bucketS;
  const size = b < 3600 ? `${b / 60} min` : b < 86_400 ? `${b / 3600} h` : `${b / 86_400} day`;
  return `${size} averages · shaded band = min–max`;
}

export default function Dashboard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [packs, setPacks] = useState<PackSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<PackDetail | null>(null);
  const [series, setSeries] = useState<Point[]>([]);
  const [history, setHistory] = useState<History | null>(null);
  const [range, setRange] = useState<RangeKey>("live");
  const [custom, setCustom] = useState<[number, number]>(() => [Date.now() - D, Date.now()]);
  const [customDraft, setCustomDraft] = useState<[string, string]>(() => [
    toLocalInput(Date.now() - D),
    toLocalInput(Date.now()),
  ]);
  const [now, setNow] = useState(() => Date.now());
  const [apiDown, setApiDown] = useState(false);

  const poll = useCallback(async () => {
    const [st, list] = await Promise.all([
      getJson<Status>("/api/status"),
      getJson<PackSummary[]>("/api/packs"),
    ]);
    setApiDown(st === null);
    if (st) setStatus(st);
    if (list) setPacks(list);

    const id = selected ?? list?.[0]?.packId ?? null;
    if (id && id !== selected) setSelected(id);
    if (id) {
      const [d, s] = await Promise.all([
        getJson<PackDetail>(`/api/packs/${encodeURIComponent(id)}`),
        range === "live"
          ? getJson<Point[]>(`/api/packs/${encodeURIComponent(id)}/recent?limit=360`)
          : Promise.resolve(undefined),
      ]);
      setDetail(d);
      if (s !== undefined) setSeries(s ?? []);
    }
    setNow(Date.now());
  }, [selected, range]);

  // ?range=7d in the URL, so a view can be bookmarked or shared.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("range");
    if (RANGES.some((x) => x.key === q && x.key !== "custom")) setRange(q as RangeKey);
  }, []);

  const chooseRange = (key: RangeKey) => {
    setRange(key);
    const url = new URL(window.location.href);
    if (key === "live" || key === "custom") url.searchParams.delete("range");
    else url.searchParams.set("range", key);
    window.history.replaceState(null, "", url);
  };

  useEffect(() => {
    poll();
    const t = setInterval(poll, POLL_MS);
    return () => clearInterval(t);
  }, [poll]);

  // History mode: load the selected range, refresh once a minute.
  useEffect(() => {
    if (range === "live" || !selected) {
      setHistory(null);
      return;
    }
    let cancelled = false;
    const span = RANGES.find((r) => r.key === range)!.ms;
    const load = async () => {
      const [from, to] = range === "custom" ? custom : [Date.now() - span, Date.now()];
      const h = await getJson<History>(
        `/api/packs/${encodeURIComponent(selected)}/history?from=${Math.round(from)}&to=${Math.round(to)}`,
      );
      if (!cancelled && h) {
        setHistory(h);
        setSeries(h.points);
      }
    };
    setSeries([]);
    void load();
    const t = range === "custom" ? null : setInterval(load, HISTORY_REFRESH_MS);
    return () => {
      cancelled = true;
      if (t) clearInterval(t);
    };
  }, [range, selected, custom]);

  const r = detail?.latest;
  const domain: [number, number] | undefined = history ? [history.from, history.to] : undefined;
  const gapMs = Math.max((history?.bucketS ?? 0) * 2500, (status?.staleAfterS ?? 60) * 1000);

  return (
    <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6">
      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-4">
        <div className="flex items-center gap-3">
          <Image src="/em-logo.png" alt="Exergi Murphy" width={64} height={45} priority />
          <div>
            <h1 className="text-lg font-semibold text-brand-dark">Battery Monitor</h1>
            <p className="text-xs text-ink-3">Live telemetry · refreshes every {POLL_MS / 1000} s</p>
          </div>
        </div>
        <ConnectionBadge status={status} apiDown={apiDown} />
      </header>

      {/* Pack selector */}
      {packs.length > 0 && (
        <nav className="mt-4 flex flex-wrap gap-2">
          {packs.map((p) => (
            <button
              key={p.packId}
              onClick={() => setSelected(p.packId)}
              className={`rounded-lg border px-3 py-2 text-left text-sm transition ${
                p.packId === selected
                  ? "border-brand bg-brand-wash text-brand-dark"
                  : "border-line bg-white text-ink-2 hover:border-brand-light"
              }`}
            >
              <div className="flex items-center gap-2 font-medium">
                <span className={`h-2 w-2 rounded-full ${p.online ? "bg-brand-mid" : "bg-ink-3"}`} />
                {p.label || p.packId}
              </div>
              <div className="text-xs text-ink-3">
                {p.seriesCount ? `${p.seriesCount}S · ` : ""}
                {fmt(p.voltage, 1, "V")} · {p.online ? ago(p.lastSeen, now) : `offline, ${ago(p.lastSeen, now)}`}
                {p.activeAlarms.length > 0 && <span className="ml-1 font-semibold text-crit">· {p.activeAlarms.length} alarm</span>}
              </div>
            </button>
          ))}
        </nav>
      )}

      {!r ? (
        <EmptyState status={status} apiDown={apiDown} />
      ) : (
        <main className="mt-5 space-y-5">
          {/* Banners */}
          {!detail!.online && (
            <Banner tone="warn">
              No data from <b>{r.packId}</b> for {ago(detail!.lastSeen, now).replace(" ago", "")}. Showing the last reading received.
            </Banner>
          )}
          {r.activeAlarms.length > 0 && (
            <Banner tone="crit">
              BMS alarm: {r.activeAlarms.map((a) => ALARM_LABEL[a] ?? a).join(", ")}
            </Banner>
          )}
          {r.silentCells.length > 0 && (
            <Banner tone="crit">
              Cell{r.silentCells.length > 1 ? "s" : ""} {r.silentCells.join(", ")} reading 0 V inside the string — likely a sense-lead fault.
            </Banner>
          )}

          {/* Key figures */}
          <section className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            <StatCard label="Pack voltage" value={fmt(r.voltage, 1, "V")} sub={r.seriesCount ? `${r.seriesCount} cells in series` : undefined} />
            <StatCard
              label="Current"
              value={fmt(r.current, 1, "A")}
              sub={r.current === null ? undefined : r.current > 0.2 ? "charging" : r.current < -0.2 ? "discharging" : "idle"}
            />
            <StatCard label="Power" value={fmt(r.power, 0, "W")} sub="V × I" />
            <StatCard label="State of charge" value={fmt(r.soc, 1, "%")} sub={r.remainingAh === null ? undefined : `${fmt(r.remainingAh, 1, "Ah")} remaining`} />
            <StatCard
              label="Cell spread"
              value={r.spreadMv === null ? "—" : `${r.spreadMv} mV`}
              sub={r.cellMin === null ? undefined : `${fmt(r.cellMin, 3)} – ${fmt(r.cellMax, 3)} V`}
              tone={r.spreadMv !== null && r.spreadMv > 50 ? "crit" : r.spreadMv !== null && r.spreadMv > 20 ? "warn" : "normal"}
            />
            <StatCard
              label="Temperature"
              value={r.moduleTemps.length ? `${Math.max(...r.moduleTemps.map((m) => m.value)).toFixed(1)} °C` : "—"}
              sub={r.moduleTemps.length ? r.moduleTemps.map((m) => `T${m.index} ${m.value.toFixed(1)}`).join(" · ") : "no sensors reporting"}
              tone={r.moduleTemps.some((m) => m.value > 50) ? "crit" : r.moduleTemps.some((m) => m.value > 40) ? "warn" : "normal"}
            />
          </section>

          {/* Cells */}
          <section className="rounded-xl border border-line bg-white p-5 shadow-sm">
            <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-semibold text-ink">Cell voltages</h2>
              <span className="text-xs text-ink-3">
                average {fmt(r.cellAvg, 3, "V")}
                {r.sumMismatchV !== null && (
                  <> · cells sum to pack voltage within {Math.abs(r.sumMismatchV).toFixed(3)} V
                    {Math.abs(r.sumMismatchV) > 0.5 && <b className="text-crit"> — check scaling</b>}
                  </>
                )}
              </span>
            </div>
            <CellBars cells={r.cells} silent={r.silentCells} />
          </section>

          {/* Trends */}
          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap gap-1">
                {RANGES.map((x) => (
                  <button
                    key={x.key}
                    onClick={() => chooseRange(x.key)}
                    className={`rounded-md border px-2.5 py-1 text-xs font-medium transition ${
                      range === x.key
                        ? "border-brand bg-brand-wash text-brand-dark"
                        : "border-line bg-white text-ink-2 hover:border-brand-light"
                    }`}
                  >
                    {x.label}
                  </button>
                ))}
              </div>
              <span className="text-xs text-ink-3">{describeSource(history)}</span>
            </div>
            {range === "custom" && (
              <form
                className="flex flex-wrap items-center gap-2 text-xs text-ink-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const from = new Date(customDraft[0]).getTime();
                  const to = new Date(customDraft[1]).getTime();
                  if (Number.isFinite(from) && Number.isFinite(to) && from < to) setCustom([from, to]);
                }}
              >
                <label>
                  From{" "}
                  <input
                    type="datetime-local"
                    value={customDraft[0]}
                    onChange={(e) => setCustomDraft([e.target.value, customDraft[1]])}
                    className="rounded-md border border-line bg-white px-2 py-1"
                  />
                </label>
                <label>
                  to{" "}
                  <input
                    type="datetime-local"
                    value={customDraft[1]}
                    onChange={(e) => setCustomDraft([customDraft[0], e.target.value])}
                    className="rounded-md border border-line bg-white px-2 py-1"
                  />
                </label>
                <button type="submit" className="rounded-md border border-brand bg-brand-wash px-3 py-1 font-medium text-brand-dark">
                  Show
                </button>
              </form>
            )}
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
              <Sparkline
                label="Pack voltage"
                unit="V"
                domain={domain}
                gapMs={gapMs}
                points={series.map((p) => ({ t: p.t, v: p.voltage, lo: p.voltageMin, hi: p.voltageMax }))}
              />
              <Sparkline
                label="Current"
                unit="A"
                domain={domain}
                gapMs={gapMs}
                points={series.map((p) => ({ t: p.t, v: p.current, lo: p.currentMin, hi: p.currentMax }))}
              />
              <Sparkline label="State of charge" unit="%" domain={domain} gapMs={gapMs} points={series.map((p) => ({ t: p.t, v: p.soc }))} />
              <Sparkline
                label="Cell spread"
                unit="mV"
                dp={0}
                domain={domain}
                gapMs={gapMs}
                points={series.map((p) => ({ t: p.t, v: p.spreadMv, hi: p.spreadMax }))}
              />
            </div>
          </section>

          {/* Device info */}
          <section className="grid gap-3 md:grid-cols-2">
            <div className="rounded-xl border border-line bg-white p-5 text-sm shadow-sm">
              <h2 className="mb-3 font-semibold">BMS alarms</h2>
              <ul className="space-y-1.5">
                {Object.entries(r.alarms).map(([k, on]) => (
                  <li key={k} className="flex justify-between">
                    <span className="text-ink-2">{ALARM_LABEL[k] ?? k}</span>
                    <span className={on ? "font-semibold text-crit" : "text-brand"}>{on ? "ACTIVE" : "OK"}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-xl border border-line bg-white p-5 text-sm shadow-sm">
              <h2 className="mb-3 font-semibold">Device</h2>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
                <dt className="text-ink-3">Device ID</dt><dd className="font-mono">{r.packId}</dd>
                {detail!.site && (<><dt className="text-ink-3">Site</dt><dd>{detail!.site}</dd></>)}
                <dt className="text-ink-3">Status</dt><dd>{r.status}</dd>
                <dt className="text-ink-3">Topic</dt><dd className="break-all font-mono text-xs">{r.topic}</dd>
                <dt className="text-ink-3">Last message</dt><dd>{new Date(detail!.lastSeen).toLocaleString()} ({ago(detail!.lastSeen, now)})</dd>
                <dt className="text-ink-3">Messages</dt><dd>{detail!.messages.toLocaleString()} since {new Date(detail!.firstSeen).toLocaleString()}</dd>
                <dt className="text-ink-3">Device clock</dt>
                <dd className={r.clockSkewS !== null && Math.abs(r.clockSkewS) > 300 ? "font-semibold text-warn" : ""}>
                  {skew(r.clockSkewS)}
                  {r.clockSkewS !== null && Math.abs(r.clockSkewS) > 300 && " — enable NTP on the ESP32"}
                </dd>
                <dt className="text-ink-3">Host temp</dt><dd>{r.hostTemp === null ? "not fitted" : `${r.hostTemp.toFixed(1)} °C`}</dd>
              </dl>
            </div>
          </section>
        </main>
      )}

      <footer className="mt-8 flex flex-wrap justify-between gap-2 border-t border-line pt-3 text-xs text-ink-3">
        <span>Exergi Murphy Power Solutions</span>
        {status?.db.ok && status.db.readingsBytes !== null && (
          <span>history stored in database · {formatBytes(status.db.readingsBytes)} of readings</span>
        )}
      </footer>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function Banner({ tone, children }: { tone: "warn" | "crit"; children: React.ReactNode }) {
  const cls = tone === "crit" ? "border-crit/40 bg-crit-bg text-crit" : "border-warn/40 bg-warn-bg text-warn";
  return <div className={`rounded-lg border px-4 py-2.5 text-sm ${cls}`}>{children}</div>;
}

function ConnectionBadge({ status, apiDown }: { status: Status | null; apiDown: boolean }) {
  if (apiDown) return <Pill tone="crit" text="Server not responding" />;
  if (!status) return <Pill tone="muted" text="Connecting…" />;
  if (!status.db.ok) return <Pill tone="crit" text="Database unreachable" />;
  if (!status.ingest) return <Pill tone="crit" text="Ingest not running" />;
  const ing = status.ingest;
  return (
    <div className="flex items-center gap-3 text-xs text-ink-3">
      <span className="hidden sm:inline">
        {ing.mqtt.broker.replace(/^mqtts?:\/\//, "")} · {ing.messages.received} msgs
        {ing.writer.buffered > 100 && <b className="text-warn"> · {ing.writer.buffered} waiting to be saved</b>}
      </span>
      {ing.mqtt.connected ? <Pill tone="ok" text="Broker connected" /> : <Pill tone="crit" text="Broker disconnected" />}
    </div>
  );
}

function Pill({ tone, text }: { tone: "ok" | "crit" | "muted"; text: string }) {
  const cls =
    tone === "ok"
      ? "bg-brand-wash text-brand-dark border-brand-light"
      : tone === "crit"
        ? "bg-crit-bg text-crit border-crit/40"
        : "bg-white text-ink-3 border-line";
  return <span className={`rounded-full border px-3 py-1 text-xs font-medium ${cls}`}>{text}</span>;
}

/** When nothing is showing, say exactly why. */
function EmptyState({ status, apiDown }: { status: Status | null; apiDown: boolean }) {
  let title = "Waiting for data";
  let hint = "Connected to the broker. Nothing has arrived on the topic yet — is the device powered and publishing?";
  const ing = status?.ingest;
  if (apiDown) {
    title = "The dashboard server is not responding";
    hint = "Is `npm run dev` (or `docker compose up`) still running?";
  } else if (status && !status.db.ok) {
    title = "Cannot reach the database";
    hint = `Start it with \`docker compose up -d db\`. Error: ${status.db.error ?? "unknown"}`;
  } else if (status && !ing) {
    title = "The ingest service is not running";
    hint = `Nothing is receiving MQTT messages. Start it with \`npm run ingest:dev\` (or \`docker compose up -d\`). ${status.ingestError ?? ""}`;
  } else if (ing && !ing.mqtt.connected) {
    title = "Not connected to the MQTT broker";
    hint = ing.mqtt.lastError?.includes("ENOTFOUND")
      ? "This machine cannot resolve the broker hostname. Usually DNS: set DNS to 1.1.1.1 for this network, then restart ingest."
      : `Last error: ${ing.mqtt.lastError ?? "none yet — still connecting"}`;
  } else if (ing && ing.messages.received > 0 && ing.messages.accepted === 0) {
    title = "Messages are arriving but all were rejected";
    const r = ing.messages.rejected;
    hint =
      r.notAllowed > 0
        ? `Device ${ing.packs.unknown.map((u) => u.deviceId).join(", ") || "?"} is not an enabled pack. Add it to ALLOWED_DEVICES in .env.local and restart ingest.`
        : r.notJson > 0
          ? "Payloads are not valid JSON."
          : r.noDeviceId > 0
            ? "Payloads have no valid device_id field."
            : `Payload problem: ${ing.messages.lastRejection ?? "unknown"}`;
  }
  return (
    <div className="mt-10 rounded-xl border border-line bg-white p-8 text-center shadow-sm">
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      <p className="mx-auto mt-2 max-w-xl text-sm text-ink-2">{hint}</p>
      {ing && (
        <p className="mt-4 font-mono text-xs text-ink-3">
          topic {ing.mqtt.topic} · received {ing.messages.received} · accepted {ing.messages.accepted} ·
          rejected {Object.values(ing.messages.rejected).reduce((a, b) => a + b, 0)}
        </p>
      )}
    </div>
  );
}
