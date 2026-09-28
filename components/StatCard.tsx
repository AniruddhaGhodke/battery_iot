export function StatCard({
  label,
  value,
  sub,
  tone = "normal",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "normal" | "warn" | "crit";
}) {
  const toneCls =
    tone === "crit"
      ? "border-crit/40 bg-crit-bg"
      : tone === "warn"
        ? "border-warn/40 bg-warn-bg"
        : "border-line bg-white";
  return (
    <div className={`rounded-xl border p-4 shadow-sm ${toneCls}`}>
      <div className="text-xs font-medium uppercase tracking-wide text-ink-3">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-ink">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-ink-2">{sub}</div>}
    </div>
  );
}
