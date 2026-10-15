import { PGlite } from '@electric-sql/pglite';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Database, Queryable, Result } from '../server/db.js';
import { migrate } from '../server/db.js';
import { readConfig } from '../server/config.js';
import { hashPassword, bootstrapAdmin } from '../server/auth.js';
import { createApp } from '../server/app.js';
import type { OpenRemote } from '../server/remote.js';

export class TestDatabase implements Database {
  private db: PGlite;
  constructor(directory?: string) { this.db = new PGlite(directory); }
  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<Result<T>> {
    const r = await this.db.query<T>(sql, params); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  }
  async transaction<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
    return this.db.transaction(tx => fn({ query: async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => { const r = await tx.query<R>(sql, params); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; } }));
  }
  async close() { await this.db.close(); }
}
export async function fixture(options: { maxBytes?: number; open?: OpenRemote } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'simpledrive-test-'));
  const config = readConfig({ DATABASE_URL: 'postgresql://unused', SESSION_SECRET: 'test-secret-with-more-than-32-characters', BASE_URL: 'http://localhost:5173', DATA_DIR: directory, MIN_FREE_BYTES: '0', MAX_FILE_BYTES: String(options.maxBytes ?? 2_000_000_000), ADMIN_EMPLOYEE_CODE: 'ADMIN', ADMIN_PASSWORD: 'Admin-Test-Password-123!' });
  const db = new TestDatabase(); await migrate(db); await bootstrapAdmin(db, config);
  const employeeId = randomUUID(); const otherId = randomUUID();
  const password = await hashPassword('Employee-Test-Password-123!');
  for (const [id, employeeCode] of [[employeeId, 'NV001'], [otherId, 'NV002']]) await db.query(`INSERT INTO users(id,employee_code,name,password_hash,role,quota_bytes) VALUES($1,$2,$2,$3,'employee',$4)`, [id, employeeCode, password, 20_000_000_000]);
  const { app, worker } = await createApp(db, config, { worker: false, open: options.open });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as { port: number }; const base = `http://127.0.0.1:${address.port}`;
  async function login(employeeCode = 'NV001') {
    const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: config.BASE_URL }, body: JSON.stringify({ employeeCode, password: employeeCode === 'ADMIN' ? 'Admin-Test-Password-123!' : 'Employee-Test-Password-123!' }) });
    if (response.status !== 200) throw new Error(await response.text());
    const body = await response.json() as { csrf: string; user: { id: string } };
    return { cookie: response.headers.get('set-cookie')!.split(';')[0], csrf: body.csrf, id: body.user.id };
  }
  async function send(route: string, auth: Awaited<ReturnType<typeof login>>, options: RequestInit = {}) {
    return fetch(`${base}${route}`, { ...options, headers: { Cookie: auth.cookie, Origin: config.BASE_URL, 'X-CSRF-Token': auth.csrf, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  }
  return { app, worker, db, config, base, employeeId, otherId, login, send, async close() { await app.close(); await db.close(); await rm(directory, { recursive: true, force: true }); } };
}
export async function eventually(fn: () => Promise<boolean>, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error('Timed out waiting for worker state');
}
