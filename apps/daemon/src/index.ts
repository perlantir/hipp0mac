import { buildApp } from "./server.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = await buildApp({ config });

const close = async (): Promise<void> => {
  await app.close();
};

process.once("SIGINT", () => {
  void close().finally(() => process.exit(0));
});

process.once("SIGTERM", () => {
  void close().finally(() => process.exit(0));
});

try {
  await app.listen({
    host: config.host,
    port: config.port
  });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

