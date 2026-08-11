/**
 * Next.js instrumentation hook — runs once when the server process starts.
 * The self-hosted deployment is a single long-lived node, so this is the
 * right place to start the periodic framework lease-recovery scan that
 * reclaims sessions orphaned by a crash/restart.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startFrameworkLeaseRecovery } = await import("./framework/core/runtime/lease-recovery");
    startFrameworkLeaseRecovery();
  }
}
