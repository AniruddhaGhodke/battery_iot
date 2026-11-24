"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { StatusChip, when } from "@/components/StatusChip";
import type { ConfigRequestRow, ConfigurablePack } from "@/lib/config-data";
import { type FirmwareImage, isOtaRequested } from "@/lib/firmware";
import { isFinal } from "@/lib/pack-config";

type Payload = { images: FirmwareImage[]; packs: ConfigurablePack[]; requests: ConfigRequestRow[] };

function size(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** Why a pack cannot be sent an update, or null. */
function blocked(p: ConfigurablePack): string | null {
  if (!p.topicSlug) return "has not published telemetry yet, so its topic is unknown";
  if (!p.deviceUid) {
    return "has not reported a hardware UID. An update names its target by UID, so this board has to be running firmware that sends one before it can be updated over the air — the first one goes on over USB";
  }
  if (!p.online) return "is offline. It has to be connected to download the image";
  return null;
}

export function Firmware({ initial }: { initial: Payload }) {
  const [data, setData] = useState<Payload>(initial);
  const [file, setFile] = useState<File | null>(null);
  const [version, setVersion] = useState("");
  const [notes, setNotes] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadNote, setUploadNote] = useState<string | null>(null);

  const [device, setDevice] = useState(initial.packs[0]?.deviceId ?? "");
  const [imageId, setImageId] = useState<number | null>(initial.images[0]?.id ?? null);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const pack = data.packs.find((p) => p.deviceId === device) ?? null;
  const image = data.images.find((i) => i.id === imageId) ?? null;
  const why = pack ? blocked(pack) : "No packs are enabled";

  const refresh = useCallback(async () => {
    try {
      const [f, c] = await Promise.all([
        fetch("/api/firmware", { cache: "no-store" }),
        fetch("/api/config", { cache: "no-store" }),
      ]);
      if (!f.ok) return;
      const fw = (await f.json()) as { images: FirmwareImage[]; requests: ConfigRequestRow[] };
      const packs = c.ok ? ((await c.json()) as { packs: ConfigurablePack[] }).packs : data.packs;
      setData({ images: fw.images, requests: fw.requests, packs });
    } catch {
      // a failed poll is not worth showing; the next one will do
    }
  }, [data.packs]);

  // Poll while a rollout is in flight. An update takes minutes, not seconds.
  useEffect(() => {
    const open = data.requests.some((r) => !isFinal(r.status));
    if (!open) {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
      return;
    }
    if (!timer.current) timer.current = setInterval(() => void refresh(), 5000);
  }, [data.requests, refresh]);

  async function upload() {
    if (!file) return;
    setUploadError(null);
    setUploadNote(null);
    setUploading(true);
    try {
      const form = new FormData();
      form.set("image", file);
      form.set("version", version.trim());
      if (notes.trim()) form.set("notes", notes.trim());
      const res = await fetch("/api/firmware", { method: "POST", body: form });
      const body = (await res.json()) as { image?: FirmwareImage; existed?: boolean; error?: string };
      if (!res.ok || !body.image) {
        setUploadError(body.error ?? `upload failed (${res.status})`);
      } else {
        setUploadNote(
          body.existed
            ? `These exact bytes were already uploaded as ${body.image.version}. Using that entry.`
            : `Stored ${body.image.version}, ${size(body.image.bytes)}.`,
        );
        setImageId(body.image.id);
        setFile(null);
        setVersion("");
        setNotes("");
        await refresh();
      }
    } catch (e) {
      setUploadError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function install() {
    if (!image || !pack) return;
    setSendError(null);
    setSending(true);
    try {
      const res = await fetch("/api/ota", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_id: pack.deviceId, firmware_id: image.id }),
      });
      const body = (await res.json()) as { error?: string; details?: string[] };
      if (!res.ok) setSendError([body.error, ...(body.details ?? [])].filter(Boolean).join(" · "));
      setConfirming(false);
      await refresh();
    } catch (e) {
      setSendError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-line bg-white p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-ink">Upload an image</h2>
        <p className="mt-1 text-xs text-ink-2">
          The <code className="font-mono">firmware.bin</code> from{" "}
          <code className="font-mono">.pio/build/&lt;env&gt;/</code> — not the{" "}
          <code className="font-mono">.elf</code>. Its SHA-256 is computed here and becomes both the
          file name and the hash the pack checks against what it wrote to flash, so an image that
          arrives damaged is refused by the device itself.
        </p>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-ink-2">
            Image
            <input
              type="file"
              accept=".bin,application/octet-stream"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="mt-1 block w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink file:mr-3 file:rounded file:border-0 file:bg-surface-2 file:px-2 file:py-1 file:text-xs"
            />
          </label>
          <label className="text-xs text-ink-2">
            Version
            <input
              type="text"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              placeholder="1.1.0"
              maxLength={31}
              spellCheck={false}
              className="mt-1 block w-full rounded-lg border border-line bg-white px-3 py-2 font-mono text-sm text-ink focus:border-brand focus:outline-none"
            />
          </label>
          <label className="text-xs text-ink-2 sm:col-span-2">
            What changed (optional)
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={200}
              className="mt-1 block w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none"
            />
          </label>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void upload()}
            disabled={uploading || !file || !version.trim()}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-40"
          >
            {uploading ? "Uploading…" : "Upload"}
          </button>
          {uploadNote && <span className="text-xs text-ink-2">{uploadNote}</span>}
        </div>
        {uploadError && (
          <p className="mt-3 rounded-lg border border-crit/40 bg-crit-bg p-3 text-sm text-crit">
            {uploadError}
          </p>
        )}

        {data.images.length > 0 && (
          <ul className="mt-4 divide-y divide-line/60 rounded-lg border border-line">
            {data.images.map((i) => (
              <li key={i.id} className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2">
                <span className="text-sm text-ink">
                  <span className="font-mono font-medium">{i.version}</span>
                  <span className="ml-2 text-xs text-ink-3">
                    {size(i.bytes)} · {i.sha256.slice(0, 12)}…
                  </span>
                  {i.notes && <span className="block text-xs text-ink-2">{i.notes}</span>}
                </span>
                <span className="text-xs text-ink-3">
                  {i.uploadedBy} · {when(i.uploadedAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-crit/30 bg-white p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-ink">Install on a pack</h2>
        <p className="mt-1 text-xs text-ink-2">
          One pack at a time. The pack downloads the image itself over HTTPS, checks the hash,
          writes it to its spare partition and restarts into it.
        </p>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-ink-2">
            Pack
            <select
              value={device}
              onChange={(e) => {
                setDevice(e.target.value);
                setConfirming(false);
              }}
              className="mt-1 block w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none"
            >
              {data.packs.map((p) => (
                <option key={p.deviceId} value={p.deviceId}>
                  {p.deviceId}
                  {p.firmwareVersion ? ` — running ${p.firmwareVersion}` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-ink-2">
            Image
            <select
              value={imageId ?? ""}
              onChange={(e) => {
                setImageId(e.target.value ? Number(e.target.value) : null);
                setConfirming(false);
              }}
              className="mt-1 block w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none"
            >
              <option value="">Choose…</option>
              {data.images.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.version} ({size(i.bytes)})
                </option>
              ))}
            </select>
          </label>
        </div>

        {pack && (
          <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-2">
            <div>
              <dt className="inline text-ink-3">UID: </dt>
              <dd className="inline font-mono font-medium">{pack.deviceUid ?? "not reported"}</dd>
            </div>
            <div>
              <dt className="inline text-ink-3">Running: </dt>
              <dd className="inline font-medium">{pack.firmwareVersion ?? "not reported"}</dd>
            </div>
            <div>
              <dt className="inline text-ink-3">Status: </dt>
              <dd className="inline font-medium">{pack.online ? "Online" : "Offline"}</dd>
            </div>
          </dl>
        )}

        {why && (
          <p className="mt-3 rounded-lg border border-warn/40 bg-warn-bg p-3 text-sm text-warn">
            {pack ? `${pack.deviceId} ${why}.` : why}
          </p>
        )}

        {image && pack?.firmwareVersion === image.version && (
          <p className="mt-3 rounded-lg border border-line bg-surface-2 p-3 text-xs text-ink-2">
            This pack already reports {image.version}. Sending it again will reflash and restart it.
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          {!confirming ? (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              disabled={!image || !!why}
              className="rounded-lg border border-crit/40 bg-white px-4 py-2 text-sm font-medium text-crit transition hover:bg-crit-bg disabled:cursor-not-allowed disabled:opacity-40"
            >
              Install{image ? ` ${image.version}` : ""}…
            </button>
          ) : (
            <>
              <span className="text-sm text-ink-2">
                Install <span className="font-mono font-medium">{image?.version}</span> on{" "}
                <span className="font-medium">{pack?.deviceId}</span>?
              </span>
              <button
                type="button"
                onClick={() => void install()}
                disabled={sending}
                className="rounded-lg bg-crit px-4 py-2 text-sm font-medium text-white transition disabled:opacity-40"
              >
                {sending ? "Sending…" : "Yes, install"}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-2"
              >
                Cancel
              </button>
            </>
          )}
        </div>
        {sendError && (
          <p className="mt-3 rounded-lg border border-crit/40 bg-crit-bg p-3 text-sm text-crit">{sendError}</p>
        )}

        <ul className="mt-4 list-disc space-y-1 pl-5 text-xs text-ink-2 marker:text-ink-3">
          <li>
            The pack stops publishing while it downloads and restarts — several minutes. Its offline
            alert is held off for that time, so nothing is sent to WhatsApp for it.
          </li>
          <li>
            Downloads run over Wi-Fi only in this firmware. A pack on the cellular backup keeps the
            command and waits for Wi-Fi.
          </li>
          <li>
            The image goes to the spare partition, never over the running one, and the pack keeps the
            old one. If the new build fails its own check on boot, the pack falls back to what it was
            running and this page reports the update failed.
          </li>
        </ul>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-ink">Rollouts</h2>
        {data.requests.length === 0 ? (
          <p className="mt-2 rounded-xl border border-line bg-white p-4 text-sm text-ink-2">
            No pack has been updated from here yet.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {data.requests.map((r) => {
              const req = isOtaRequested(r.requested) ? r.requested : null;
              return (
                <li key={r.id} className="rounded-xl border border-line bg-white p-3 shadow-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-medium text-ink">
                      {r.deviceId} · <span className="font-mono">{req?.version ?? "?"}</span>
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
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
