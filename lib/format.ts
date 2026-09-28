export function fmt(v: number | null | undefined, dp = 1, unit = ""): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${v.toFixed(dp)}${unit ? ` ${unit}` : ""}`;
}

export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function skew(s: number | null): string {
  if (s === null) return "—";
  const a = Math.abs(s);
  const dir = s < 0 ? "behind" : "ahead";
  if (a < 60) return `${a}s ${dir}`;
  if (a < 3600) return `${Math.round(a / 60)} min ${dir}`;
  return `${(a / 3600).toFixed(1)} h ${dir}`;
}
