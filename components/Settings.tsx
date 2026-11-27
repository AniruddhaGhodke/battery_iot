"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { StatusChip, when } from "@/components/StatusChip";
import { REPORTED_FOR_FIELD, type ReportedKey } from "@/lib/bms-setpoints";
import type { ConfigRequestRow, ConfigurablePack, ControlRequested } from "@/lib/config-data";
import { CONTROL_ACTIONS, CONTROL_MAX_CURRENT_A } from "@/lib/pack-control";
import {
  CONFIG_FIELDS,
  type ConfigKey,
  type ConfigSettings,
  fieldError,
  FIELD_BY_KEY,
  FIELD_GROUPS,
  type FieldSpec,
  GROUP_HELP,
  GROUP_LABEL,
  isFinal,
} from "@/lib/pack-config";

type Payload = { packs: ConfigurablePack[]; requests: ConfigRequestRow[] };

function describe(r: ConfigRequestRow): string {
  if (r.kind === "control") {
    const c = r.requested as ControlRequested;
    const spec = CONTROL_ACTIONS.find((x) => x.action === c.action);
    return `${spec?.label ?? c.action} ${c.value}`;
  }
  return Object.entries(r.requested as ConfigSettings)
    .map(([k, v]) => {
      const f = FIELD_BY_KEY[k as ConfigKey];
      if (!f) return `${k} ${String(v)}`;
      if (f.kind === "bool") return `${f.label} ${v === f.onValue ? "on" : "off"}`;
      if (f.kind === "text") return `${f.label} ${String(v)}`;
      return `${f.label} ${Number(v).toLocaleString("en-IN")} ${f.unit}`.trim();
    })
    .join(", ");
}

/** One setting: a tick to include it, and its value. Disabled when pending. */
function Field({
  f,
  checked,
  value,
  reported,
  onToggle,
  onValue,
}: {
  f: FieldSpec;
  checked: boolean;
  value: string;
  /** What the BMS says this limit is, as a raw count. */
  reported: number | undefined;
  onToggle: (on: boolean) => void;
  onValue: (v: string) => void;
}) {
  const pending = !!f.pending;
  return (
    <div
      className={`rounded-lg border p-3 ${pending ? "border-line/60 bg-surface-2/50" : "border-line bg-surface-2"}`}
    >
      <label className={`flex items-start gap-2 ${pending ? "cursor-not-allowed" : "cursor-pointer"}`}>
        <input
          type="checkbox"
          checked={checked}
          disabled={pending}
          onChange={(e) => onToggle(e.target.checked)}
          className="mt-1 size-4 accent-brand disabled:opacity-40"
        />
        <span className="min-w-0">
          <span className={`text-sm font-medium ${pending ? "text-ink-3" : "text-ink"}`}>{f.label}</span>
          {f.unit && <span className="ml-1 text-xs text-ink-3">({f.unit})</span>}
          {f.canCommand && (
            <span className="ml-2 rounded border border-line bg-white px-1.5 py-0.5 font-mono text-[10px] text-ink-3">
              CAN {f.canCommand}
            </span>
          )}
          {pending && (
            <span className="ml-2 rounded border border-warn/40 bg-warn-bg px-1.5 py-0.5 text-[10px] font-medium text-warn">
              Awaiting firmware
            </span>
          )}
          <span className="block text-xs text-ink-2">{f.help}</span>
          {reported !== undefined && (
            <span className="mt-1 block text-xs text-ink-2">
              <span className="font-medium text-ink">BMS reports {reported.toLocaleString("en-IN")} raw</span>
              {f.canScale ? (
                <>
                  {" = "}
                  <span className="font-medium text-ink">
                    {(reported / f.canScale).toFixed(String(1 / f.canScale).split(".")[1]?.length ?? 0)}{" "}
                    {f.unit}
                  </span>{" "}
                  <span className="text-ink-3">if the scale is right — check it against the BMS app</span>
                </>
              ) : (
                <span className="text-ink-3"> — scale unconfirmed, check it against the BMS app</span>
              )}
            </span>
          )}
        </span>
      </label>

      {checked && !pending && (
        <div className="mt-2 pl-6">
          {f.kind === "enum" ? (
            <select
              value={value}
              onChange={(e) => onValue(e.target.value)}
              className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none"
            >
              <option value="">Choose…</option>
              {f.values.map((v) => (
                <option key={v} value={v}>
                  {v} {f.unit}
                </option>
              ))}
            </select>
          ) : f.kind === "bool" ? (
            <select
              value={value}
              onChange={(e) => onValue(e.target.value)}
              className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none"
            >
              <option value="">Choose…</option>
              <option value={f.onValue}>On</option>
              <option value={f.offValue}>Off</option>
            </select>
          ) : f.kind === "text" ? (
            <input
              type="text"
              maxLength={f.maxLength}
              value={value}
              onChange={(e) => onValue(e.target.value)}
              placeholder={f.placeholder}
              spellCheck={false}
              className="w-64 rounded-lg border border-line bg-white px-3 py-2 font-mono text-sm text-ink focus:border-brand focus:outline-none"
            />
          ) : (
            <input
              type="number"
              inputMode="numeric"
              min={f.min}
              max={f.max}
              step={f.step}
              value={value}
              onChange={(e) => onValue(e.target.value)}
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
  );
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
  // Which control action the user has confirmed. Nothing switches without it.
  const [confirm] = useState<string | null>(null);
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
      const v = f.kind === "text" ? raw.trim() : Number(raw);
      const err = fieldError(f, v);
      if (err) errors.push(err);
      else settings[f.key] = v;
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

  const addressable = pack?.topicSlug != null;
  const pendingCount = CONFIG_FIELDS.filter((f) => f.pending).length;

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

        {pendingCount > 0 && (
          <p className="mt-3 rounded-lg border border-line bg-surface-2 p-3 text-xs text-ink-2">
            <span className="font-medium text-ink">{pendingCount} settings are listed but cannot be sent yet.</span>{" "}
            The BMS accepts them over CAN, but two things have to be settled first: the gateway has
            to forward them from MQTT, and the protocol document does not say what units these
            16-bit values are in — it gives units for 3 of its 28 commands, and it already disagrees
            with the working firmware about capacity and state of charge. A protection limit written
            ten times too high is an over-current trip that never trips, so the pack now reports what
            it is actually running and each scale is fixed against that before any of it is sent.
          </p>
        )}

        <div className="mt-4 space-y-5">
          {FIELD_GROUPS.map((g) => {
            const fields = CONFIG_FIELDS.filter((f) => f.group === g);
            if (!fields.length) return null;
            return (
              <div key={g}>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-3">
                  {GROUP_LABEL[g]}
                </h3>
                <p className="mt-0.5 text-xs text-ink-2">{GROUP_HELP[g]}</p>
                <div className="mt-2 space-y-2">
                  {fields.map((f) => (
                    <Field
                      key={f.key}
                      f={f}
                      checked={!!include[f.key]}
                      value={values[f.key] ?? ""}
                      reported={
                        pack?.bmsSetpoints?.[REPORTED_FOR_FIELD[f.key] as ReportedKey] ?? undefined
                      }
                      onToggle={(on) => {
                        setInclude((p) => ({ ...p, [f.key]: on }));
                        // Nothing to choose when there is only one value.
                        if (on && f.kind === "enum" && f.values.length === 1) {
                          setField(f.key, String(f.values[0]));
                        }
                      }}
                      onValue={(v) => setField(f.key, v)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>

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
              <StatusChip status={current.status} />
              {current.error && <span className="text-xs text-ink-3">{current.error}</span>}
            </span>
          )}
        </div>
        <p className="mt-2 text-xs text-ink-3">
          Sent means the broker accepted it, not that the device applied it. Applied appears once the
          device acknowledges — and, for a restart, once telemetry comes back.
        </p>
      </section>

      <section className="rounded-xl border border-crit/30 bg-white p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-ink">Channel control</h2>
        <p className="mt-1 text-xs text-ink-2">
          Opening and closing the path the current flows through. Kept apart from the settings above
          because it is a control action, not a configuration change: it has its own MQTT topic and
          ACL entry, an expiry so a queued command cannot fire late, and an interlock.
        </p>

        {CONTROL_ACTIONS.map((c) => (
          <div key={c.action} className="mt-3 rounded-lg border border-line/60 bg-surface-2/50 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-ink-3">{c.label}</span>
              <span className="rounded border border-line bg-white px-1.5 py-0.5 font-mono text-[10px] text-ink-3">
                CAN {c.canCommand}
              </span>
              {c.pending && (
                <span className="rounded border border-warn/40 bg-warn-bg px-1.5 py-0.5 text-[10px] font-medium text-warn">
                  Awaiting firmware
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-ink-2">{c.help}</p>

            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                disabled
                className="rounded-lg border border-line bg-white px-3 py-1.5 text-sm text-ink-3 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Close channel (on)
              </button>
              <button
                type="button"
                disabled
                className="rounded-lg border border-crit/40 bg-white px-3 py-1.5 text-sm text-crit disabled:cursor-not-allowed disabled:opacity-50"
              >
                Open channel (off)
              </button>
              {confirm !== c.action ? (
                <span className="text-xs text-ink-3">Confirmation is required before either acts.</span>
              ) : null}
            </div>
          </div>
        ))}

        <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-ink-2 marker:text-ink-3">
          <li>
            The channel is not opened while the pack is carrying more than {CONTROL_MAX_CURRENT_A} A
            — breaking a contactor under load arcs and can weld the contacts. Checked on the server
            against the pack&apos;s last reading, not in this page.
          </li>
          <li>
            Nothing is switched if telemetry is stale: without a current reading the pack&apos;s state
            is unknown, and switching blind is worse than not switching.
          </li>
          <li>
            Set <span className="font-medium">Channel state after power-on</span> above to match. A
            channel opened remotely closes again on the next power cycle unless that says otherwise.
          </li>
        </ul>
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
                    {r.deviceId} · {describe(r)}
                  </span>
                  <span className="flex items-center gap-2">
                    <StatusChip status={r.status} />
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
