"use client";

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import type { Reading } from "@/lib/telemetry";
import type { StoreStats } from "@/lib/store";
import { ago, fmt, skew } from "@/lib/format";
import { StatCard } from "./StatCard";
import { Sparkline } from "./Sparkline";
import { CellBars } from "./CellBars";

const POLL_MS = 3000;

type PackSummary = {
  packId: string;
  online: boolean;
  lastSeen: number;
  messages: number;
  seriesCount: number;
  voltage: number | null;
  current: number | null;
  soc: number | null;
  spreadMv: number | null;
  activeAlarms: string[];
};
type PackDetail = { packId: string; online: boolean; messages: number; firstSeen: number; latest: Reading };
type Point = { t: number; voltage: number | null; current: number | null; power: number | null; soc: number | null; spreadMv: number | null; maxTemp: number | null };
type Status = StoreStats & { packs: number; uptimeS: number };

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

export default function Dashboard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [packs, setPacks] = useState<PackSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<PackDetail | null>(null);
  const [series, setSeries] = useState<Point[]>([]);
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
        getJson<Point[]>(`/api/packs/${encodeURIComponent(id)}/recent?limit=360`),
      ]);
      setDetail(d);
      setSeries(s ?? []);
    }
    setNow(Date.now());
  }, [selected]);

  useEffect(() => {
    poll();
    const t = setInterval(poll, POLL_MS);
    return () => clearInterval(t);
  }, [poll]);

  const r = detail?.latest;

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
                {p.packId}
              </div>
              <div className="text-xs text-ink-3">
                {p.seriesCount ? `${p.seriesCount}S · ` : ""}
                {fmt(p.voltage, 1, "V")} · {p.online ? ago(p.lastSeen, now) : "offline"}
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
              No data from <b>{r.packId}</b> for {ago(r.receivedAt, now).replace(" ago", "")}. Showing the last reading received.
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
          <section className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
            <Sparkline label="Pack voltage" unit="V" points={series.map((p) => ({ t: p.t, v: p.voltage }))} />
            <Sparkline label="Current" unit="A" points={series.map((p) => ({ t: p.t, v: p.current }))} />
            <Sparkline label="State of charge" unit="%" points={series.map((p) => ({ t: p.t, v: p.soc }))} />
            <Sparkline label="Cell spread" unit="mV" dp={0} points={series.map((p) => ({ t: p.t, v: p.spreadMv }))} />
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
                <dt className="text-ink-3">Status</dt><dd>{r.status}</dd>
                <dt className="text-ink-3">Topic</dt><dd className="break-all font-mono text-xs">{r.topic}</dd>
                <dt className="text-ink-3">Last message</dt><dd>{new Date(r.receivedAt).toLocaleTimeString()} ({ago(r.receivedAt, now)})</dd>
                <dt className="text-ink-3">Messages</dt><dd>{detail!.messages} since {new Date(detail!.firstSeen).toLocaleTimeString()}</dd>
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

      <footer className="mt-8 border-t border-line pt-3 text-xs text-ink-3">
        Exergi Murphy Power Solutions · data held in memory only — restarting the server clears it
      </footer>
    </div>
  );
}

function Banner({ tone, children }: { tone: "warn" | "crit"; children: React.ReactNode }) {
  const cls = tone === "crit" ? "border-crit/40 bg-crit-bg text-crit" : "border-warn/40 bg-warn-bg text-warn";
  return <div className={`rounded-lg border px-4 py-2.5 text-sm ${cls}`}>{children}</div>;
}

function ConnectionBadge({ status, apiDown }: { status: Status | null; apiDown: boolean }) {
  if (apiDown) return <Pill tone="crit" text="Server not responding" />;
  if (!status) return <Pill tone="muted" text="Connecting…" />;
  return (
    <div className="flex items-center gap-3 text-xs text-ink-3">
      <span className="hidden sm:inline">
        {status.broker.replace(/^mqtts?:\/\//, "")} · {status.received} msgs
      </span>
      {status.connected ? <Pill tone="ok" text="Broker connected" /> : <Pill tone="crit" text="Broker disconnected" />}
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

/** When nothing is showing, say exactly why - the lesson of the last two days. */
function EmptyState({ status, apiDown }: { status: Status | null; apiDown: boolean }) {
  let title = "Waiting for data";
  let hint = "Connected to the broker. Nothing has arrived on the topic yet — is the device powered and publishing?";
  if (apiDown) {
    title = "The dashboard server is not responding";
    hint = "Is `npm run dev` still running in the terminal?";
  } else if (status && !status.connected) {
    title = "Not connected to the MQTT broker";
    hint = status.lastError?.includes("ENOTFOUND")
      ? "Your Mac cannot resolve the broker hostname. This is the DNS problem from before — set DNS to 1.1.1.1 for this network."
      : `Last error: ${status.lastError ?? "none yet — still connecting"}`;
  } else if (status && status.received > 0 && status.accepted === 0) {
    title = "Messages are arriving but all were rejected";
    const r = status.rejected;
    hint =
      r.notAllowed > 0
        ? `The device_id is not in ALLOWED_DEVICES (${status.allowlist.join(", ") || "empty"}). Add it to .env.local and restart.`
        : r.notJson > 0
          ? "Payloads are not valid JSON."
          : r.noDeviceId > 0
            ? "Payloads have no valid device_id field."
            : `Payload problem: ${status.lastError ?? "unknown"}`;
  }
  return (
    <div className="mt-10 rounded-xl border border-line bg-white p-8 text-center shadow-sm">
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      <p className="mx-auto mt-2 max-w-xl text-sm text-ink-2">{hint}</p>
      {status && (
        <p className="mt-4 font-mono text-xs text-ink-3">
          topic {status.topic} · received {status.received} · accepted {status.accepted} ·
          rejected {Object.values(status.rejected).reduce((a, b) => a + b, 0)}
        </p>
      )}
    </div>
  );
}
