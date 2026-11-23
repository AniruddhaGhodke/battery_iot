import Image from "next/image";
import Link from "next/link";
import { activeAlerts, type AlertRow, listAlerts } from "@/lib/alerts-data";
import { conditionLabel } from "@/lib/condition-label";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TZ = process.env.ALERT_TIMEZONE || "Asia/Kolkata";

function when(ms: number): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: TZ,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(ms);
}

function since(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `${Math.floor(s / 86_400)} days`;
}

const CONFIDENCE: Record<string, string> = {
  likely: "border-brand/40 bg-brand-wash text-brand-dark",
  possible: "border-warn/40 bg-warn-bg text-warn",
  unclear: "border-line bg-surface-2 text-ink-3",
};

function Report({ a }: { a: AlertRow }) {
  const d = a.analysis;
  if (!d) return null;
  const hours = (d.window.to - d.window.from) / 3_600_000;
  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-md border px-2 py-0.5 text-xs font-medium capitalize ${CONFIDENCE[d.confidence] ?? CONFIDENCE.unclear}`}>
          {d.confidence}
        </span>
        <span className="text-xs text-ink-3">
          from {d.window.readings.toLocaleString("en-IN")} readings over {hours.toFixed(0)} h
        </span>
      </div>

      <p className="mt-2 text-sm font-medium text-ink">{d.summary}</p>

      {d.findings.length > 0 && (
        <dl className="mt-3 grid gap-2 sm:grid-cols-2">
          {d.findings.map((f, i) => (
            <div key={i} className="rounded-lg border border-line bg-surface-2 px-3 py-2">
              <dt className="text-xs font-medium uppercase tracking-wide text-ink-3">{f.label}</dt>
              <dd className="mt-0.5 text-sm font-semibold tabular-nums text-ink">{f.value}</dd>
              {f.note && <dd className="mt-0.5 text-xs text-ink-2">{f.note}</dd>}
            </div>
          ))}
        </dl>
      )}

      {d.causes.length > 0 && (
        <section className="mt-4">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-3">Probable cause</h4>
          <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm text-ink-2 marker:text-ink-3">
            {d.causes.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ol>
        </section>
      )}

      {d.actions.length > 0 && (
        <section className="mt-4">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-3">What to check</h4>
          <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm text-ink-2 marker:text-ink-3">
            {d.actions.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ol>
        </section>
      )}

      <p className="mt-3 text-xs text-ink-3">
        Worked out from the stored readings alone. Confirm against the pack before acting on it.
      </p>
    </div>
  );
}

export default async function AlertsPage() {
  let log: AlertRow[] = [];
  let active: Awaited<ReturnType<typeof activeAlerts>> = [];
  let error: string | null = null;
  try {
    [log, active] = await Promise.all([listAlerts(50), activeAlerts()]);
  } catch (e) {
    error = (e as Error).message;
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-5 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-4">
        <div className="flex items-center gap-3">
          <Image src="/em-logo.png" alt="Exergi Murphy" width={64} height={45} priority />
          <div>
            <h1 className="text-lg font-semibold text-brand-dark">Alerts</h1>
            <p className="text-xs text-ink-3">What was raised, why, and what to check</p>
          </div>
        </div>
        <nav className="flex items-center gap-2">
          <Link
            href="/settings"
            className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-2 hover:border-brand-light"
          >
            Settings
          </Link>
          <Link
            href="/"
            className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-2 hover:border-brand-light"
          >
            ← Live dashboard
          </Link>
        </nav>
      </header>

      {error && (
        <p className="mt-4 rounded-xl border border-crit/40 bg-crit-bg p-4 text-sm text-crit">
          Cannot reach the database: {error}
        </p>
      )}

      <section className="mt-5">
        <h2 className="text-sm font-semibold text-ink">Raised now</h2>
        {active.length === 0 ? (
          <p className="mt-2 rounded-xl border border-line bg-white p-4 text-sm text-ink-2">
            Nothing is raised. Every pack and the server itself are inside their limits.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {active.map((a) => (
              <li key={a.key} className="rounded-xl border border-crit/40 bg-crit-bg p-3 text-sm">
                <span className="font-semibold text-ink">{conditionLabel(a.condition)}</span>
                <span className="text-ink-2"> · {a.pack ?? "Monitoring server"}</span>
                <span className="text-ink-3"> · {since(a.since)} ago</span>
                {!a.notified && <span className="text-ink-3"> · not messaged (cooldown)</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-6">
        <h2 className="text-sm font-semibold text-ink">History</h2>
        {log.length === 0 ? (
          <p className="mt-2 rounded-xl border border-line bg-white p-4 text-sm text-ink-2">
            No alerts recorded yet.
          </p>
        ) : (
          <ul className="mt-2 space-y-3">
            {log.map((a) => (
              <li key={a.id} className="rounded-xl border border-line bg-white p-4 shadow-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <span className="text-sm font-semibold text-ink">{conditionLabel(a.condition)}</span>
                    <span className="text-sm text-ink-2">
                      {" "}
                      {a.kind === "cleared" ? "cleared" : "raised"} · {a.pack ?? "Monitoring server"}
                    </span>
                  </div>
                  <span className="text-xs tabular-nums text-ink-3">{when(a.ts)}</span>
                </div>

                <p className="mt-1 text-sm text-ink-2">{a.detail}</p>

                {!a.sent && (
                  <p className="mt-1 text-xs text-ink-3">
                    Not messaged{a.error ? `: ${a.error}` : ""}.
                  </p>
                )}

                {a.analysis && (
                  <details className="group mt-2">
                    <summary className="cursor-pointer text-sm font-medium text-brand hover:text-brand-dark">
                      Cause analysis
                    </summary>
                    <Report a={a} />
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
