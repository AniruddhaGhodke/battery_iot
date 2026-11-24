import Image from "next/image";
import Link from "next/link";
import { Settings } from "@/components/Settings";
import {
  type ConfigRequestRow,
  type ConfigurablePack,
  listConfigRequests,
  listConfigurablePacks,
} from "@/lib/config-data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function SettingsPage() {
  let initial: { packs: ConfigurablePack[]; requests: ConfigRequestRow[] } = {
    packs: [],
    requests: [],
  };
  let error: string | null = null;
  try {
    const [packs, requests] = await Promise.all([listConfigurablePacks(), listConfigRequests(20)]);
    initial = { packs, requests };
  } catch (e) {
    error = (e as Error).message;
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-5 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-4">
        <div className="flex items-center gap-3">
          <Image src="/em-logo.png" alt="Exergi Murphy" width={64} height={45} priority />
          <div>
            <h1 className="text-lg font-semibold text-brand-dark">Pack settings</h1>
            <p className="text-xs text-ink-3">Send configuration to a pack and see what it answers</p>
          </div>
        </div>
        <nav className="flex items-center gap-2">
          <Link
            href="/firmware"
            className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-2 hover:border-brand-light"
          >
            Firmware
          </Link>
          <Link
            href="/alerts"
            className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-2 hover:border-brand-light"
          >
            Alerts
          </Link>
          <Link
            href="/"
            className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-2 hover:border-brand-light"
          >
            ← Live dashboard
          </Link>
        </nav>
      </header>

      {error ? (
        <p className="mt-4 rounded-xl border border-crit/40 bg-crit-bg p-4 text-sm text-crit">
          Cannot reach the database: {error}
        </p>
      ) : (
        <div className="mt-5">
          <Settings initial={initial} />
        </div>
      )}
    </div>
  );
}
