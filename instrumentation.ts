/**
 * Next.js instrumentation hook — runs once when the server process starts.
 * The self-hosted deployment is a single long-lived node, so this is the
 * right place to start the periodic lease-recovery scan that reclaims runs
 * orphaned by a crash/restart.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startLeaseRecovery } = await import("./lib/lease-recovery");
    startLeaseRecovery();
  }
}
