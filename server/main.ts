import { readConfig } from './config.js';
import { PgDatabase, migrate } from './db.js';
import { bootstrapAdmin } from './auth.js';
import { createApp } from './app.js';
import { loadEnvFile } from 'node:process';
import { initializeStorage } from './storage.js';
import { formatStartupError, type StartupStage } from './startup-errors.js';

let stage: StartupStage = 'environment';
let db: PgDatabase | undefined;
let runningApp: Awaited<ReturnType<typeof createApp>>['app'] | undefined;
async function main() {
  // Also support npm start / node directly. Environment supplied by Docker or the shell keeps precedence.
  try { loadEnvFile('.env'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  stage = 'configuration';
  const config = readConfig();
  stage = 'storage';
  await initializeStorage(config);
  stage = 'database';
  const database = new PgDatabase(config.DATABASE_URL); db = database;
  await migrate(database, config.ADMIN_EMPLOYEE_CODE);
  stage = 'admin';
  await bootstrapAdmin(database, config);
  stage = 'application';
  const { app } = await createApp(database, config, { logger: true }); runningApp = app;
  stage = 'listen';
  await app.listen({ host: config.HOST, port: config.PORT });
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    if (closing) return; closing = true;
    void app.close().then(() => database.close()).then(() => process.exit(0)).catch(() => process.exit(1));
  });
}
main().catch(async error => {
  console.error(formatStartupError(error, stage));
  if (runningApp) await runningApp.close().catch(() => {});
  if (db) await db.close().catch(() => {});
  process.exitCode = 1;
});
