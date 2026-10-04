/** Shape of ingest's GET /status, read by the web app's /api/status. */

export type IngestStatus = {
  startedAt: number;
  uptimeS: number;
  mqtt: {
    connected: boolean;
    broker: string;
    topic: string;
    clientId: string;
    connects: number;
    disconnects: number;
    lastError: string | null;
    lastMessageAt: number | null;
  };
  messages: {
    received: number;
    accepted: number;
    rejected: {
      tooLarge: number;
      notJson: number;
      noDeviceId: number;
      notAllowed: number;
      badPayload: number;
    };
    lastRejection: string | null;
  };
  writer: {
    buffered: number;
    written: number;
    duplicates: number;
    dropped: number;
    flushes: number;
    errors: number;
    lastWriteAt: number | null;
    lastFlushMs: number | null;
    lastError: string | null;
  };
  packs: {
    enabled: number;
    autoRegister: boolean;
    /** device_ids seen on the topic but not accepted. */
    unknown: { deviceId: string; count: number; lastSeen: number }[];
  };
};

/** Shape of the web app's GET /api/status. */
export type Status = {
  ingest: IngestStatus | null;
  /** Why ingest could not be reached, when `ingest` is null. */
  ingestError: string | null;
  db: {
    ok: boolean;
    error: string | null;
    sizeBytes: number | null;
    readingsBytes: number | null;
  };
  staleAfterS: number;
};
