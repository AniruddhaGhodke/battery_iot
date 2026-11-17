/**
 * Alerts plumbing: feeds the AlertEngine, turns its events into WhatsApp
 * messages, and keeps alert_active / alert_log in the database.
 *
 *   readings + 5 s tick ──► AlertEngine ──► events ──► queue ──► WhatsApp
 *                                                 └──► alert_log
 *
 * Nothing here may throw into the ingest loop: a failed send or a database
 * error is logged and counted, never fatal.
 */

import type { Sql } from "postgres";
import type { Reading } from "../lib/telemetry.ts";
import type { AlertStatus } from "../lib/ingest-status.ts";
import {
  type ActiveRecord,
  type AlertEvent,
  AlertEngine,
  type AlertOptions,
  clock,
  conditionLabel,
  setAlertTimeZone,
  type SystemHealth,
} from "./alerts.ts";
import { WhatsAppError, WhatsAppSender, type WhatsAppConfig } from "./whatsapp.ts";

export type NotifierConfig = AlertOptions & {
  enabled: boolean;
  recipients: string[];
  whatsapp: WhatsAppConfig;
  timeZone: string;
  timeZoneLabel: string;
  maxPerHour: number;
};

/** One WhatsApp message: one or more events of the same pack and kind. */
export type Message = {
  pack: string | null;
  events: AlertEvent[];
  /** Template variables {{1}}..{{4}}. */
  params: [string, string, string, string];
};

const RETRY_DELAYS_MS = [5_000, 30_000];

export function whatsappConfigured(c: NotifierConfig): boolean {
  return Boolean(c.whatsapp.token && c.whatsapp.phoneNumberId && c.recipients.length);
}

/** Groups one batch of events into messages: per pack, raised and cleared apart. */
export function toMessages(events: AlertEvent[], tzLabel: string): Message[] {
  const groups = new Map<string, AlertEvent[]>();
  for (const e of events) {
    const g = `${e.pack ?? ""}|${e.kind}|${e.notify}`;
    groups.set(g, [...(groups.get(g) ?? []), e]);
  }
  return [...groups.values()].map((evs) => {
    const first = evs[0];
    const labels = evs.map((e) => conditionLabel(e.condition));
    let headline: string;
    if (first.kind === "raised") {
      const icon = evs.some((e) => e.condition.startsWith("alarm:") || e.condition.startsWith("system:")) ? "🔴" : "🟠";
      headline = evs.length === 1 ? `${icon} ${labels[0]}` : `${icon} ${evs.length} alerts: ${labels.join(", ")}`;
    } else if (evs.length === 1 && first.condition === "offline") {
      headline = "✅ Pack back online";
    } else {
      headline = `✅ Cleared: ${labels.join(", ")}`;
    }
    const details = [...new Set(evs.map((e) => e.detail).filter(Boolean))].join(" | ");
    const time = `${clock(first.at)}${tzLabel ? ` ${tzLabel}` : ""}`;
    return {
      pack: first.pack,
      events: evs,
      params: [headline, first.pack ?? "Monitoring server", details || "-", time],
    };
  });
}

export class Notifier {
  private sql: Sql;
  private cfg: NotifierConfig;
  private sender: WhatsAppSender | null;
  private engine!: AlertEngine;
  private queue: Promise<void> = Promise.resolve();
  private sentTimes: number[] = [];
  private savedActive = "";
  readonly stats: Omit<AlertStatus, "active"> = {
    enabled: false,
    configured: false,
    recipients: 0,
    sent: 0,
    failed: 0,
    suppressed: 0,
    lastSentAt: null,
    lastError: null,
  };

  constructor(sql: Sql, cfg: NotifierConfig, sender?: WhatsAppSender | null) {
    this.sql = sql;
    this.cfg = cfg;
    setAlertTimeZone(cfg.timeZone);
    const configured = whatsappConfigured(cfg);
    this.sender = sender !== undefined ? sender : configured ? new WhatsAppSender(cfg.whatsapp) : null;
    this.stats.enabled = cfg.enabled;
    this.stats.configured = configured;
    this.stats.recipients = cfg.recipients.length;
  }

  /** Restores raised alerts from the database, so a restart repeats nothing. */
  async start(now = Date.now()) {
    let restored: ActiveRecord[] = [];
    try {
      const rows = await this.sql<{ key: string; since: Date; notified: boolean }[]>`
        select key, since, notified from alert_active`;
      restored = rows.map((r) => ({ key: r.key, since: r.since.getTime(), notified: r.notified }));
    } catch (e) {
      console.warn(`[alerts] could not load alert_active: ${(e as Error).message}`);
    }
    this.engine = new AlertEngine(this.cfg, now, restored);
    this.savedActive = JSON.stringify(this.engine.active());
    const mode = !this.cfg.enabled
      ? "off (ALERTS_ENABLED is not true): alerts are logged, not sent"
      : this.sender
        ? `on, ${this.cfg.recipients.length} recipient(s), template ${this.cfg.whatsapp.template}`
        : "ON BUT NOT CONFIGURED: set WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID and ALERT_RECIPIENTS";
    console.log(`[alerts] WhatsApp ${mode}; ${restored.length} alert(s) restored`);
  }

  active(): AlertStatus["active"] {
    return this.engine ? this.engine.active() : [];
  }

  observe(r: Reading, now = Date.now()) {
    if (!this.engine) return;
    this.handle(this.engine.observe(r, now));
  }

  tick(packs: string[], sys: SystemHealth, now = Date.now()) {
    if (!this.engine) return;
    this.handle(this.engine.tick(now, packs, sys));
    void this.saveActive();
  }

  /** Resolves once everything queued so far is sent (tests, shutdown). */
  idle(): Promise<void> {
    return this.queue;
  }

  private handle(events: AlertEvent[]) {
    if (!events.length) return;
    for (const m of toMessages(events, this.cfg.timeZoneLabel)) {
      for (const e of m.events) {
        console.log(`[alerts] ${e.kind.toUpperCase()} ${e.pack ?? "system"} ${e.condition}${e.notify ? "" : " (cooldown, not sent)"}: ${e.detail}`);
      }
      this.queue = this.queue.then(() => this.deliver(m)).catch((e) => {
        console.warn(`[alerts] ${(e as Error).message}`);
      });
    }
    void this.saveActive();
  }

  private async deliver(m: Message) {
    let sent = false;
    let error: string | null = null;
    const now = Date.now();
    this.sentTimes = this.sentTimes.filter((t) => now - t < 3_600_000);

    if (!m.events[0].notify) error = "cooldown";
    else if (!this.cfg.enabled) error = "alerts off";
    else if (!this.sender) error = "WhatsApp not configured";
    else if (this.sentTimes.length + this.cfg.recipients.length > this.cfg.maxPerHour) error = "hourly cap reached";

    if (error) {
      this.stats.suppressed++;
    } else {
      const failures: string[] = [];
      for (const to of this.cfg.recipients) {
        try {
          await this.sendWithRetry(to, m.params);
          this.sentTimes.push(Date.now());
        } catch (e) {
          failures.push(`${mask(to)}: ${(e as Error).message}`);
        }
      }
      sent = failures.length < this.cfg.recipients.length;
      if (sent) {
        this.stats.sent++;
        this.stats.lastSentAt = Date.now();
      }
      if (failures.length) {
        this.stats.failed++;
        error = failures.join("; ");
        this.stats.lastError = error;
        console.warn(`[alerts] send failed: ${error}`);
      }
    }
    await this.log(m, sent, error);
  }

  private async sendWithRetry(to: string, params: string[]) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.sender!.send(to, params);
      } catch (e) {
        const retry = e instanceof WhatsAppError && e.retryable && attempt < RETRY_DELAYS_MS.length;
        if (!retry) throw e;
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
    }
  }

  private async log(m: Message, sent: boolean, error: string | null) {
    try {
      const rows = m.events.map((e) => ({
        ts: new Date(e.at),
        pack: e.pack,
        condition: e.condition,
        kind: e.kind,
        headline: m.params[0],
        detail: e.detail,
        sent,
        error,
      }));
      await this.sql`insert into alert_log ${this.sql(rows)}`;
    } catch (e) {
      console.warn(`[alerts] could not write alert_log: ${(e as Error).message}`);
    }
  }

  /** Mirrors the engine's raised alerts into alert_active when they change. */
  private async saveActive() {
    const active = this.engine.active();
    const snapshot = JSON.stringify(active);
    if (snapshot === this.savedActive) return;
    this.savedActive = snapshot;
    try {
      await this.sql.begin(async (tx) => {
        await tx`delete from alert_active`;
        if (active.length) {
          await tx`insert into alert_active ${tx(
            active.map((a) => ({
              key: `${a.pack ?? "system"}|${a.condition}`,
              since: new Date(a.since),
              notified: a.notified,
            })),
          )}`;
        }
      });
    } catch (e) {
      this.savedActive = ""; // try again next tick
      if (!(e as Error).message.includes("ECONNREFUSED")) {
        console.warn(`[alerts] could not save alert_active: ${(e as Error).message}`);
      }
    }
  }
}

/** "919876543210" -> "91******3210": recipients never appear whole in logs. */
function mask(n: string): string {
  const d = n.replace(/\D/g, "");
  return d.length > 6 ? `${d.slice(0, 2)}${"*".repeat(d.length - 6)}${d.slice(-4)}` : "***";
}

/** `--test-alert`: one test message to every recipient, even with ALERTS_ENABLED off. */
export async function sendTestAlert(cfg: NotifierConfig): Promise<boolean> {
  setAlertTimeZone(cfg.timeZone);
  if (!whatsappConfigured(cfg)) {
    console.error("[alerts] set WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID and ALERT_RECIPIENTS first");
    return false;
  }
  const sender = new WhatsAppSender(cfg.whatsapp);
  const params = [
    "🧪 Test alert",
    "Monitoring server",
    "If you can read this, battery alerts will reach this number.",
    `${clock(Date.now())}${cfg.timeZoneLabel ? ` ${cfg.timeZoneLabel}` : ""}`,
  ];
  let ok = true;
  for (const to of cfg.recipients) {
    try {
      const id = await sender.send(to, params);
      console.log(`[alerts] sent to ${mask(to)} (${id})`);
    } catch (e) {
      ok = false;
      console.error(`[alerts] ${mask(to)}: ${(e as Error).message}`);
    }
  }
  return ok;
}
