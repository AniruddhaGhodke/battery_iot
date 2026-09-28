/**
 * Runs once when the Next.js server starts. Opens the MQTT subscription so
 * data is being collected before anyone loads the dashboard.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getStore } = await import("./lib/store");
    getStore();
  }
}
