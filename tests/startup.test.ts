import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readConfig } from '../server/config.js';
import { formatStartupError } from '../server/startup-errors.js';

test('bootstrap admin accepts eight characters and rejects seven without lowering the session-secret minimum', () => {
  const env = { DATABASE_URL: 'postgresql://unused', SESSION_SECRET: 'session-secret-with-more-than-32-characters', ADMIN_PASSWORD: 'Admin123' };
  assert.equal(readConfig(env).ADMIN_PASSWORD, 'Admin123');
  assert.throws(() => readConfig({ ...env, ADMIN_PASSWORD: 'Short12' }));
  assert.throws(() => readConfig({ ...env, SESSION_SECRET: 'short-secret' }));
});

test('startup lists each invalid or placeholder variable without printing configured values', () => {
  const env = { DATABASE_URL: 'postgresql://test:database-password@localhost/simpledrive', SESSION_SECRET: 'replace-with-a-random-secret-of-at-least-32-characters', ADMIN_PASSWORD: 'replace-with-a-strong-password' };
  let failure: unknown;
  try { readConfig(env); } catch (error) { failure = error; }
  const output = formatStartupError(failure, 'configuration', env);
  assert.match(output, /SESSION_SECRET: vẫn là giá trị mẫu/); assert.match(output, /ADMIN_PASSWORD: vẫn là giá trị mẫu/);
  assert.ok(!output.includes(env.SESSION_SECRET)); assert.ok(!output.includes(env.ADMIN_PASSWORD)); assert.ok(!output.includes('database-password'));
  try { readConfig({ SESSION_SECRET: 'private-short-value' }); } catch (error) {
    const validation = formatStartupError(error, 'configuration', { SESSION_SECRET: 'private-short-value' });
    assert.match(validation, /DATABASE_URL: chưa được cấu hình/); assert.match(validation, /SESSION_SECRET: cần ít nhất 32 ký tự/); assert.ok(!validation.includes('private-short-value'));
  }
});

test('startup preserves error codes, addresses, paths and stack while redacting credentials and nested causes', () => {
  const env = { DATABASE_URL: 'postgresql://user:private%40password@db:5432/simpledrive', ADMIN_PASSWORD: 'admin-private-password', SESSION_SECRET: 'session-private-secret', GOOGLE_DRIVE_API_KEY: 'private-api-key' };
  const nested = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED', address: '127.0.0.1', port: 5432 });
  const error = new AggregateError([nested], `Failed ${env.DATABASE_URL} admin-private-password private@password https://example.com/?key=unknown-secret`);
  const output = formatStartupError(error, 'database', env);
  assert.match(output, /ECONNREFUSED/); assert.match(output, /127\.0\.0\.1/); assert.match(output, /PostgreSQL chưa nhận kết nối/); assert.match(output, /at /);
  for (const secret of ['private%40password','private@password','admin-private-password','unknown-secret']) assert.ok(!output.includes(secret), secret);
  const storage = formatStartupError(Object.assign(new Error('permission denied'), { code: 'EACCES', path: '/data/files' }), 'storage');
  assert.match(storage, /\/data\/files/); assert.match(storage, /quyền/);
  const listen = formatStartupError(Object.assign(new Error('address in use'), { code: 'EADDRINUSE', port: 4000 }), 'listen');
  assert.match(listen, /4000/); assert.match(listen, /đổi PORT/);
  const login = formatStartupError(Object.assign(new Error('password authentication failed'), { code: '28P01' }), 'database');
  assert.match(login, /không tự đổi mật khẩu/);
});

test('direct startup reads .env and reports the real configuration failure; shell environment has precedence', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'simpledrive-startup-'));
  try {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const key of ['DATABASE_URL','SESSION_SECRET','ADMIN_PASSWORD','ADMIN_EMPLOYEE_CODE','BASE_URL','NODE_OPTIONS']) delete env[key];
    await writeFile(path.join(directory, '.env'), 'DATABASE_URL=postgresql://unused\nSESSION_SECRET=replace-with-a-random-secret-of-at-least-32-characters\nADMIN_PASSWORD=replace-with-a-strong-password\n');
    const entry = path.resolve('server/main.ts');
    const loader = import.meta.resolve('tsx');
    const run = spawnSync(process.execPath, ['--import', loader, entry], { cwd: directory, env, encoding: 'utf8', timeout: 15_000 });
    assert.equal(run.status, 1, run.stderr); assert.match(run.stderr, /SESSION_SECRET: vẫn là giá trị mẫu/); assert.match(run.stderr, /ADMIN_PASSWORD: vẫn là giá trị mẫu/);
    assert.ok(!run.stderr.includes('DATABASE_URL: chưa được cấu hình')); assert.ok(!run.stderr.includes('replace-with-a-strong-password'));
    const override = spawnSync(process.execPath, ['--import', loader, entry], { cwd: directory, env: { ...env, SESSION_SECRET: 'valid-shell-secret-longer-than-32-characters' }, encoding: 'utf8', timeout: 15_000 });
    assert.equal(override.status, 1, override.stderr); assert.ok(!override.stderr.includes('SESSION_SECRET: vẫn là giá trị mẫu')); assert.match(override.stderr, /ADMIN_PASSWORD: vẫn là giá trị mẫu/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
