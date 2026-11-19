/** Human names for alert conditions. Shared by ingest and the web app. */

import type { Alarms } from "./telemetry";

export const ALARM_LABELS: Record<keyof Alarms, string> = {
  over_current: "Over-current",
  over_discharge: "Over-discharge (low voltage)",
  over_charge: "Over-charge (high voltage)",
  over_temperature: "Over-temperature",
  cell_string_error: "Cell string error",
};

export function conditionLabel(condition: string): string {
  if (condition.startsWith("alarm:")) {
    const k = condition.slice(6) as keyof Alarms;
    return ALARM_LABELS[k] ?? k;
  }
  switch (condition) {
    case "cell:silent":
      return "Cell reading 0 V";
    case "cell:spread":
      return "High cell imbalance";
    case "offline":
      return "Pack offline";
    case "system:mqtt":
      return "MQTT broker unreachable";
    case "system:db":
      return "Database unreachable";
    default:
      return condition;
  }
}
