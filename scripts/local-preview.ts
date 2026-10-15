import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { TestDatabase } from '../tests/helpers.js';
import { migrate } from '../server/db.js';
import { bootstrapAdmin } from '../server/auth.js';
import { readConfig } from '../server/config.js';
import { createApp } from '../server/app.js';

const data = path.resolve('data/local-preview'); await mkdir(data, { recursive: true });
const accessFile = path.join(data, 'access.json');
let access: { employeeCode: string; password: string; secret: string };
try {
  const stored = JSON.parse(await readFile(accessFile, 'utf8'));
  access = { employeeCode: stored.employeeCode ?? 'ADMIN', password: stored.password, secret: stored.secret };
  if (!stored.employeeCode) await writeFile(accessFile, JSON.stringify(access, null, 2), { mode: 0o600 });
}
catch { access = { employeeCode: 'ADMIN', password: randomBytes(18).toString('base64url'), secret: randomBytes(32).toString('hex') }; await writeFile(accessFile, JSON.stringify(access, null, 2), { mode: 0o600 }); }
const config = readConfig({ BASE_URL: 'http://127.0.0.1:4173', DATABASE_URL: 'postgresql://local-preview-only', SESSION_SECRET: access.secret, ADMIN_EMPLOYEE_CODE: access.employeeCode, ADMIN_PASSWORD: access.password, DATA_DIR: path.join(data, 'files'), MIN_FREE_BYTES: '0' });
const db = new TestDatabase(path.join(data, 'db')); await migrate(db, config.ADMIN_EMPLOYEE_CODE); await bootstrapAdmin(db, config);
const { app } = await createApp(db, config);
await app.listen({ host: '127.0.0.1', port: 4173 });
console.log('Local preview: http://127.0.0.1:4173');
console.log(`Local preview login is stored in ${accessFile}. This database is for local inspection only.`);
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (closing) return; closing = true;
  void app.close().then(() => db.close()).then(() => process.exit(0));
});
