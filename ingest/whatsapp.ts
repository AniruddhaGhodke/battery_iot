/**
 * Sends WhatsApp template messages through Meta's WhatsApp Cloud API.
 *
 * A business may only start a conversation with a template Meta has
 * approved, so every alert uses one template with four body variables:
 *
 *   {{1}} headline   e.g. "Over-temperature" / "Over-temperature cleared"
 *   {{2}} pack       device_id, or "Monitoring server"
 *   {{3}} details    one line of figures
 *   {{4}} time       e.g. "14 Nov, 12:04 IST"
 *
 * The template text itself lives in Meta's WhatsApp Manager (README,
 * "WhatsApp alerts"). Only its name and language are configured here.
 */

export type WhatsAppConfig = {
  token: string;
  phoneNumberId: string;
  template: string;
  language: string;
  apiVersion: string;
};

export class WhatsAppError extends Error {
  /** Worth trying again later: network trouble, rate limit, Meta 5xx. */
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

// Meta rejects variables with newlines or tabs, or more than 4 spaces in a row.
const MAX_PARAM = 400;
export function cleanParam(s: string): string {
  const one = s.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
  return (one.length > MAX_PARAM ? `${one.slice(0, MAX_PARAM - 1)}…` : one) || "-";
}

/** Digits only, with country code: "+91 98765-43210" -> "919876543210". */
export function normalizeNumber(n: string): string {
  return n.replace(/[^\d]/g, "");
}

export function templateBody(cfg: WhatsAppConfig, to: string, params: string[]) {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: normalizeNumber(to),
    type: "template",
    template: {
      name: cfg.template,
      language: { code: cfg.language },
      components: [
        {
          type: "body",
          parameters: params.map((p) => ({ type: "text", text: cleanParam(p) })),
        },
      ],
    },
  };
}

// Meta error codes that explain themselves better in plain words.
const HINTS: Record<number, string> = {
  190: "access token expired or invalid: use a permanent System User token",
  10: "token lacks whatsapp_business_messaging permission",
  100: "bad request: check WHATSAPP_PHONE_NUMBER_ID and the template's variables",
  131026: "recipient cannot receive this message (not on WhatsApp?)",
  131030: "recipient is not in the test number's allowed list",
  132000: "variable count does not match the template (it needs 4)",
  132001: "template not found: check WHATSAPP_TEMPLATE / WHATSAPP_TEMPLATE_LANG, and that it is approved",
  133010: "phone number not registered with the Cloud API",
};
const RETRY_CODES = new Set([4, 80007, 130429, 131000, 131016, 131048, 131056]);

export class WhatsAppSender {
  private cfg: WhatsAppConfig;
  private fetchImpl: typeof fetch;

  constructor(cfg: WhatsAppConfig, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
  }

  /** Sends one template message. Resolves with Meta's message id. */
  async send(to: string, params: string[]): Promise<string> {
    const url = `https://graph.facebook.com/${this.cfg.apiVersion}/${this.cfg.phoneNumberId}/messages`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.cfg.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(templateBody(this.cfg, to, params)),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new WhatsAppError(`network: ${(e as Error).message}`, true);
    }
    const text = await res.text();
    let json: { messages?: { id: string }[]; error?: { code?: number; message?: string } } = {};
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON: a proxy or an outage page
    }
    if (res.ok && json.messages?.[0]?.id) return json.messages[0].id;

    const code = json.error?.code;
    const hint = code !== undefined ? HINTS[code] : undefined;
    const msg = `HTTP ${res.status}${code !== undefined ? ` code ${code}` : ""}: ${hint ? `${hint} (` : ""}${json.error?.message ?? text.slice(0, 200)}${hint ? ")" : ""}`;
    const retryable = res.status === 429 || res.status >= 500 || (code !== undefined && RETRY_CODES.has(code));
    throw new WhatsAppError(msg, retryable);
  }
}
