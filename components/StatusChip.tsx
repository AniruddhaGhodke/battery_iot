import { STATUS_LABEL } from "@/lib/pack-config";

const STATUS_STYLE: Record<string, string> = {
  pending: "border-line bg-surface-2 text-ink-2",
  sent: "border-warn/40 bg-warn-bg text-warn",
  downloading: "border-warn/40 bg-warn-bg text-warn",
  restarting: "border-warn/40 bg-warn-bg text-warn",
  applied: "border-brand/40 bg-brand-wash text-brand-dark",
  rejected: "border-crit/40 bg-crit-bg text-crit",
  timeout: "border-crit/40 bg-crit-bg text-crit",
  failed: "border-crit/40 bg-crit-bg text-crit",
};

/** The state of a request to a pack, in the same colours everywhere. */
export function StatusChip({ status }: { status: string }) {
  return (
    <span
      className={`rounded-md border px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status] ?? STATUS_STYLE.pending}`}
    >
      {STATUS_LABEL[status as keyof typeof STATUS_LABEL] ?? status}
    </span>
  );
}

/** Day, month and 24-hour time, as the rest of the dashboard shows them. */
export function when(ms: number): string {
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(ms);
}
