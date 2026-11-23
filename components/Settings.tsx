"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ConfigRequestRow, ConfigurablePack } from "@/lib/config-data";
import {
  CONFIG_FIELDS,
  type ConfigKey,
  type ConfigSettings,
  fieldError,
  isFinal,
  STATUS_LABEL,
} from "@/lib/pack-config";

type Payload = { packs: ConfigurablePack[]; requests: ConfigRequestRow[] };

const STATUS_STYLE: Record<string, string> = {
  pending: "border-line bg-surface-2 text-ink-2",
  sent: "border-warn/40 bg-warn-bg text-warn",
  restarting: "border-warn/40 bg-warn-bg text-warn",
  applied: "border-brand/40 bg-brand-wash text-brand-dark",
  rejected: "border-crit/40 bg-crit-bg text-crit",
  timeout: "border-crit/40 bg-crit-bg text-crit",
  failed: "border-crit/40 bg-crit-bg text-crit",
};

function Chip({ status }: { status: string }) {
  return (
    <span
      className={`rounded-md border px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status] ?? STATUS_STYLE.pending}`}
    >
      {STATUS_LABEL[status as keyof typeof STATUS_LABEL] ?? status}
    </span>
  );
}

function when(ms: number): string {
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(ms);
}

function describe(s: ConfigSettings): string {
  return Object.entries(s)
    .map(([k, v]) => {
      const f = CONFIG_FIELDS.find((x) => x.key === k);
      return `${f?.label ?? k} ${Number(v).toLocaleString("en-IN")} ${f?.unit ?? ""}`.trim();
    })
    .join(", ");
}

export function Settings({ initial }: { initial: Payload }) {
  const [data, setData] = useState<Payload>(initial);
  const [device, setDevice] = useState(initial.packs[0]?.deviceId ?? "");
  // Which fields to send, and their values. Nothing is sent unless ticked, so
  // a setting cannot go out because it happened to be in the form.
  const [include, setInclude] = useState<Record<string, boolean>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string[] | null>(null);
  const [watching, setWatching] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const pack = data.packs.find((p) => p.deviceId === device) ?? null;

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/config", { cache: "no-store" });
      if (res.ok) setData((await res.json()) as Payload);
    } catch {
      // a failed poll is not worth showing; the next one will do
    }
  }, []);

  // Poll only while a request is outstanding.
  useEffect(() => {
    const open = data.requests.some((r) => !isFinal(r.status));
    if (!open) {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
      return;
    }
    if (!timer.current) timer.current = setInterval(() => void refresh(), 2000);
    return () => {
      if (timer.current && !open) {
        clearInterval(timer.current);
        timer.current = null;
      }
    };
  }, [data.requests, refresh]);

  useEffect(() => {
    setInclude({});
    setValues({});
    setError(null);
  }, [device]);

  const current = data.requests.find((r) => r.id === watching) ?? null;

  function setField(key: ConfigKey, v: string) {
    setValues((prev) => ({ ...prev, [key]: v }));
  }

  async function apply() {
    setError(null);
    const settings: ConfigSettings = {};
    const errors: string[] = [];
    for (const f of CONFIG_FIELDS) {
      if (!include[f.key]) continue;
      const raw = values[f.key];
      if (raw === undefined || raw === "") {
        errors.push(`${f.label}: enter a value`);
        continue;
      }
      const n = Number(raw);
      const err = fieldError(f, n);
      if (err) errors.push(err);
      else settings[f.key] = n;
    }
    if (!Object.keys(settings).length && !errors.length) errors.push("Tick a setting to send.");
    if (errors.length) {
      setError(errors);
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_id: device, settings }),
      });
      const body = (await res.json()) as { id?: number; error?: string; details?: string[] };
      if (!res.ok) {
        setError([body.error ?? `request failed (${res.status})`, ...(body.details ?? [])]);
      } else {
        setWatching(body.id ?? null);
        setInclude({});
        setValues({});
      }
      await refresh();
    } catch (e) {
      setError([(e as Error).message]);
    } finally {
      setBusy(false);
    }
  }

  const bitrateChosen = include.can_baud_kbps && values.can_baud_kbps === "500";
  const addressable = pack?.topicSlug != null;

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-line bg-white p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-ink">Device</h2>
        {data.packs.length === 0 ? (
          <p className="mt-2 text-sm text-ink-2">No enabled packs.</p>
        ) : (
          <>
            <select
              value={device}
              onChange={(e) => setDevice(e.target.value)}
              className="mt-2 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none sm:w-80"
            >
              {data.packs.map((p) => (
                <option key={p.deviceId} value={p.deviceId}>
                  {p.deviceId}
                  {p.label ? ` — ${p.label}` : ""}
                </option>
              ))}
            </select>
            {pack && (
              <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-2">
                <div>
                  <dt className="inline text-ink-3">Status: </dt>
                  <dd className="inline font-medium">{pack.online ? "Online" : "Offline"}</dd>
                </div>
                <div>
                  <dt className="inline text-ink-3">Topic: </dt>
                  <dd className="inline font-medium">{pack.topicSlug ?? "not known yet"}</dd>
                </div>
                <div>
                  <dt className="inline text-ink-3">Interval: </dt>
                  <dd className="inline font-medium">
                    {pack.telemetryIntervalMs
                      ? `${pack.telemetryIntervalMs.toLocaleString("en-IN")} ms`
                      : "not set from here"}
                  </dd>
                </div>
              </dl>
            )}
          </>
        )}
        {pack && !addressable && (
          <p className="mt-3 rounded-lg border border-warn/40 bg-warn-bg p-3 text-sm text-warn">
            This pack has not published telemetry yet, so its topic is unknown and nothing can be
            sent to it. The topic is recorded automatically on its first reading.
          </p>
        )}
      </section>

      <section className="rounded-xl border border-line bg-white p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-ink">Settings to send</h2>
        <p className="mt-1 text-xs text-ink-3">
          Only ticked settings are sent. Anything left unticked is not touched on the device.
        </p>

        <div className="mt-3 space-y-3">
          {CONFIG_FIELDS.map((f) => (
            <div key={f.key} className="rounded-lg border border-line bg-surface-2 p-3">
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={!!include[f.key]}
                  onChange={(e) => setInclude((p) => ({ ...p, [f.key]: e.target.checked }))}
                  className="mt-1 size-4 accent-brand"
                />
                <span>
                  <span className="text-sm font-medium text-ink">{f.label}</span>
                  <span className="ml-1 text-xs text-ink-3">({f.unit})</span>
                  <span className="block text-xs text-ink-2">{f.help}</span>
                </span>
              </label>

              {include[f.key] && (
                <div className="mt-2 pl-6">
                  {f.kind === "enum" ? (
                    <select
                      value={values[f.key] ?? ""}
                      onChange={(e) => setField(f.key, e.target.value)}
                      className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none"
                    >
                      <option value="">Choose…</option>
                      {f.values.map((v) => (
                        <option key={v} value={v}>
                          {v} {f.unit}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="number"
                      inputMode="numeric"
                      min={f.min}
                      max={f.max}
                      step={f.step}
                      value={values[f.key] ?? ""}
                      onChange={(e) => setField(f.key, e.target.value)}
                      placeholder={`${f.min.toLocaleString("en-IN")}–${f.max.toLocaleString("en-IN")}`}
                      className="w-48 rounded-lg border border-line bg-white px-3 py-2 text-sm tabular-nums text-ink focus:border-brand focus:outline-none"
                    />
                  )}
                  {f.restarts && (
                    <p className="mt-1 text-xs text-ink-3">
                      The device restarts after accepting this, so telemetry stops briefly.
                    </p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        {bitrateChosen && (
          <p className="mt-3 rounded-lg border border-crit/40 bg-crit-bg p-3 text-sm text-crit">
            500 kbps will stop this pack reading its BMS. The 192S protocol runs at 250 kbps and has
            no bitrate command of its own, so the pack will come back online but report nothing until
            you set it to 250 again.
          </p>
        )}

        {error && (
          <ul className="mt-3 list-disc space-y-1 rounded-lg border border-crit/40 bg-crit-bg p-3 pl-7 text-sm text-crit">
            {error.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        )}

        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void apply()}
            disabled={busy || !addressable || !Object.values(include).some(Boolean)}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Sending…" : "Send configuration"}
          </button>
          {current && (
            <span className="flex items-center gap-2 text-sm text-ink-2">
              <Chip status={current.status} />
              {current.error && <span className="text-xs text-ink-3">{current.error}</span>}
            </span>
          )}
        </div>
        <p className="mt-2 text-xs text-ink-3">
          Sent means the broker accepted it, not that the device applied it. Applied appears once the
          device acknowledges — and, for a restart, once telemetry comes back.
        </p>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-ink">Recent requests</h2>
        {data.requests.length === 0 ? (
          <p className="mt-2 rounded-xl border border-line bg-white p-4 text-sm text-ink-2">
            Nothing has been sent yet.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {data.requests.map((r) => (
              <li key={r.id} className="rounded-xl border border-line bg-white p-3 shadow-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-ink">
                    {r.deviceId} · {describe(r.requested)}
                  </span>
                  <span className="flex items-center gap-2">
                    <Chip status={r.status} />
                    <span className="text-xs tabular-nums text-ink-3">{when(r.requestedAt)}</span>
                  </span>
                </div>
                <p className="mt-1 text-xs text-ink-3">
                  by {r.requestedBy}
                  {r.error ? ` · ${r.error}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
