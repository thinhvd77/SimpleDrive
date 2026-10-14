import { readConfig } from './config.js';
import { PgDatabase, migrate } from './db.js';
import { bootstrapAdmin } from './auth.js';
import { createApp } from './app.js';

async function main() {
  const config = readConfig(); const db = new PgDatabase(config.DATABASE_URL);
  await migrate(db); await bootstrapAdmin(db, config);
  const { app } = await createApp(db, config, { logger: true });
  await app.listen({ host: config.HOST, port: config.PORT });
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    if (closing) return; closing = true;
    void app.close().then(() => db.close()).then(() => process.exit(0)).catch(() => process.exit(1));
  });
}
main().catch(() => { console.error('SimpleDrive could not start. Check environment configuration, PostgreSQL connection, and storage permissions.'); process.exitCode = 1; });
