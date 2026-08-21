/**
 * Next.js instrumentation hook — runs once when the server process starts.
 * The self-hosted deployment is a single long-lived node, so this is the
 * right place to start the periodic framework lease-recovery scan that
 * reclaims sessions orphaned by a crash/restart.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startLeaseRecovery } = await import("@zmzai/agent-framework");
    const { productEventLog } = await import("@/framework/core/events/product-event-log");
    const { mongoSessionStore } = await import("@/framework/core/session/mongo-store");
    startLeaseRecovery({
      store: {
        listExpiredLeases: async () => {
          const { connectMongo } = await import("@/lib/database/mongodb");
          const { FrameworkSessionModel } = await import("@/framework/core/session/mongo-models");
          await connectMongo();
          const rows = await FrameworkSessionModel.find({ leaseExpiresAt: { $ne: null, $lt: new Date() } }).select({ sessionId: 1 }).limit(50).lean();
          return rows.map((r) => ({ sessionId: r.sessionId }));
        },
        clearLeaseIfExpired: async (sessionId) => {
          const { connectMongo } = await import("@/lib/database/mongodb");
          const { FrameworkSessionModel } = await import("@/framework/core/session/mongo-models");
          await connectMongo();
          const reclaimed = await FrameworkSessionModel.findOneAndUpdate(
            { sessionId, leaseExpiresAt: { $ne: null, $lt: new Date() } },
            { $set: { leaseOwner: null, leaseExpiresAt: null } },
            { new: true },
          ).lean();
          return Boolean(reclaimed);
        },
      },
      // Recovery events must flow through Task/Run projections. Writing only
      // to the raw event log leaves the durable Run stuck as active forever.
      log: productEventLog,
      // 中断终态化（P2-10）：pending 审批 / running 工具 / 进行中 todo 收敛为终态
      finalizeStore: mongoSessionStore,
    });
  }
}
