/**
 * Minimal SVG line chart - no chart library.
 *
 * For bucketed history each point may carry lo/hi (min/max inside the
 * bucket), drawn as a band behind the average line. A gap longer than
 * `gapMs` breaks the line instead of drawing across missing data.
 */

type Pt = { t: number; v: number | null; lo?: number | null; hi?: number | null };

export function Sparkline({
  label,
  points,
  unit,
  dp = 1,
  domain,
  gapMs,
}: {
  label: string;
  points: Pt[];
  unit: string;
  dp?: number;
  /** x range [from, to] in epoch ms; defaults to first..last point. */
  domain?: [number, number];
  gapMs?: number;
}) {
  const pts = points.filter((p): p is Pt & { v: number } => p.v !== null);
  const W = 300;
  const H = 70;
  const latest = pts.at(-1)?.v;

  let path = "";
  let band = "";
  let lo = 0,
    hi = 0;
  const t0 = domain?.[0] ?? pts[0]?.t ?? 0;
  const t1 = domain?.[1] ?? pts.at(-1)?.t ?? 0;
  if (pts.length >= 2) {
    const los = pts.map((p) => p.lo ?? p.v);
    const his = pts.map((p) => p.hi ?? p.v);
    lo = Math.min(...los);
    hi = Math.max(...his);
    const pad = (hi - lo) * 0.1 || Math.abs(hi) * 0.01 || 1;
    const y0 = lo - pad,
      y1 = hi + pad;
    const x = (t: number) => ((t - t0) / (t1 - t0 || 1)) * W;
    const y = (v: number) => H - ((v - y0) / (y1 - y0)) * H;

    // Split into runs at gaps, then draw each run as a line (and band).
    const runs: (typeof pts)[] = [];
    pts.forEach((p, i) => {
      if (i === 0 || (gapMs && p.t - pts[i - 1].t > gapMs)) runs.push([p]);
      else runs.at(-1)!.push(p);
    });
    path = runs
      .map((run) => run.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" "))
      .join(" ");
    if (pts.some((p) => p.lo != null && p.hi != null)) {
      band = runs
        .filter((run) => run.length > 1)
        .map((run) => {
          const top = run.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.hi ?? p.v).toFixed(1)}`);
          const bottom = [...run].reverse().map((p) => `L${x(p.t).toFixed(1)},${y(p.lo ?? p.v).toFixed(1)}`);
          return `${top.join(" ")} ${bottom.join(" ")} Z`;
        })
        .join(" ");
    }
  }

  return (
    <div className="rounded-xl border border-line bg-white p-4 shadow-sm">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-ink-3">{label}</span>
        <span className="text-sm font-semibold tabular-nums">
          {latest === undefined ? "—" : `${latest.toFixed(dp)} ${unit}`}
        </span>
      </div>
      {pts.length < 2 ? (
        <div className="flex h-[70px] items-center justify-center text-xs text-ink-3">
          {domain ? "No data in this range" : "Waiting for more readings…"}
        </div>
      ) : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 h-[70px] w-full" preserveAspectRatio="none">
            {band && <path d={band} fill="var(--color-brand)" fillOpacity="0.15" stroke="none" />}
            <path d={path} fill="none" stroke="var(--color-brand)" strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
          </svg>
          <div className="mt-1 flex justify-between text-[11px] tabular-nums text-ink-3">
            <span>min {lo.toFixed(dp)}</span>
            <span>{pts.length} points</span>
            <span>max {hi.toFixed(dp)}</span>
          </div>
          <div className="flex justify-between text-[10px] tabular-nums text-ink-3">
            <span>{timeLabel(t0, t1 - t0)}</span>
            <span>{timeLabel(t1, t1 - t0)}</span>
          </div>
        </>
      )}
    </div>
  );
}

function timeLabel(t: number, spanMs: number): string {
  const d = new Date(t);
  if (spanMs <= 86_400_000) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (spanMs <= 90 * 86_400_000) {
    return d.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}
