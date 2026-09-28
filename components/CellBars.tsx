/**
 * One bar per cell. Height shows the cell's offset from the pack average,
 * scaled to the actual spread, so a 4 mV imbalance is still visible. Colour
 * and the number underneath carry the absolute value.
 */
export function CellBars({ cells, silent }: { cells: number[]; silent: number[] }) {
  if (!cells.length) {
    return (
      <p className="text-sm text-ink-3">
        This device is not sending per-cell voltages (payload schema 1).
      </p>
    );
  }
  const live = cells.filter((v) => v > 0);
  const avg = live.reduce((a, b) => a + b, 0) / live.length;
  const min = Math.min(...live);
  const max = Math.max(...live);
  // Scale to at least ±20 mV so a well-balanced pack doesn't look alarming.
  const half = Math.max((max - min) / 2, 0.02);

  return (
    <div>
      <div
        className="grid gap-1.5"
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${cells.length > 32 ? 30 : 42}px, 1fr))` }}
      >
        {cells.map((v, i) => {
          const n = i + 1;
          const dead = silent.includes(n) || v <= 0;
          const devMv = Math.round((v - avg) * 1000);
          const absDev = Math.abs(devMv);
          const color = dead
            ? "bg-crit"
            : absDev > 30
              ? "bg-crit"
              : absDev > 10
                ? "bg-warn"
                : v === max
                  ? "bg-brand-dark"
                  : v === min
                    ? "bg-brand-light"
                    : "bg-brand-mid";
          const h = dead ? 100 : 50 + ((v - avg) / half) * 45;
          return (
            <div key={n} className="flex flex-col items-center" title={`Cell ${n}: ${dead ? "no reading" : `${v.toFixed(3)} V (${devMv >= 0 ? "+" : ""}${devMv} mV)`}`}>
              <div className="flex h-24 w-full items-end rounded bg-surface-2">
                <div className={`w-full rounded ${color}`} style={{ height: `${Math.max(4, Math.min(100, h))}%` }} />
              </div>
              <div className="mt-1 text-[10px] font-medium text-ink-3">{n}</div>
              <div className="text-[10px] tabular-nums text-ink-2">{dead ? "0 V" : (v * 1000).toFixed(0)}</div>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
        <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-brand-dark" />highest</span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-brand-light" />lowest</span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-warn" />&gt;10 mV from average</span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-crit" />&gt;30 mV or no reading</span>
        <span className="text-ink-3">values in mV</span>
      </div>
    </div>
  );
}
