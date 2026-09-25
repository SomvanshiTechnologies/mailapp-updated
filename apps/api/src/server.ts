import { bootstrap } from "./bootstrap.js";
import { buildApp } from "./app.js";

async function main(): Promise<void> {
  const ctx = await bootstrap({ role: "api" });
  await ctx.queue.start(); // the API publishes jobs; workers consume them
  const app = await buildApp(ctx);

  const shutdown = async (signal: string) => {
    ctx.logger.info({ signal }, "shutting down api");
    try {
      await app.close();
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

  await app.listen({ port: ctx.config.PORT, host: "0.0.0.0" });
  ctx.logger.info(
    { port: ctx.config.PORT, sesMode: ctx.config.SES_MODE, llm: ctx.config.LLM_PROVIDER, env: ctx.config.NODE_ENV },
    "api listening",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
