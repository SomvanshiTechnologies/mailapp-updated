import { bootstrap } from "./bootstrap.js";
import { registerJobHandlers, registerSchedules } from "./jobs/register.js";

async function main(): Promise<void> {
  const ctx = await bootstrap({ role: "worker" });
  await ctx.queue.start();
  await registerJobHandlers(ctx);
  await registerSchedules(ctx);
  ctx.logger.info(
    { sesMode: ctx.config.SES_MODE, llm: ctx.config.LLM_PROVIDER, env: ctx.config.NODE_ENV },
    "worker started",
  );

  const shutdown = async (signal: string) => {
    ctx.logger.info({ signal }, "shutting down worker");
    try {
      await ctx.shutdown();
      process.exit(0);
    } catch (err) {
      ctx.logger.error({ err }, "shutdown failed");
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (err) => ctx.logger.error({ err }, "unhandledRejection"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
