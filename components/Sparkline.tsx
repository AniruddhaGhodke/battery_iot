/** Minimal SVG line chart - no chart library for step 1. */
export function Sparkline({
  label,
  points,
  unit,
  dp = 1,
}: {
  label: string;
  points: { t: number; v: number | null }[];
  unit: string;
  dp?: number;
}) {
  const pts = points.filter((p): p is { t: number; v: number } => p.v !== null);
  const W = 300;
  const H = 70;
  const latest = pts.at(-1)?.v;

  let path = "";
  let lo = 0,
    hi = 0;
  if (pts.length >= 2) {
    lo = Math.min(...pts.map((p) => p.v));
    hi = Math.max(...pts.map((p) => p.v));
    const pad = (hi - lo) * 0.1 || Math.abs(hi) * 0.01 || 1;
    const y0 = lo - pad,
      y1 = hi + pad;
    const t0 = pts[0].t,
      t1 = pts.at(-1)!.t;
    const x = (t: number) => ((t - t0) / (t1 - t0 || 1)) * W;
    const y = (v: number) => H - ((v - y0) / (y1 - y0)) * H;
    path = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
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
          Waiting for more readings…
        </div>
      ) : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 h-[70px] w-full" preserveAspectRatio="none">
            <path d={path} fill="none" stroke="var(--color-brand)" strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
          </svg>
          <div className="mt-1 flex justify-between text-[11px] tabular-nums text-ink-3">
            <span>min {lo.toFixed(dp)}</span>
            <span>{pts.length} readings</span>
            <span>max {hi.toFixed(dp)}</span>
          </div>
        </>
      )}
    </div>
  );
}
