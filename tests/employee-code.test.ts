import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, TestDatabase } from './helpers.js';
import { migrate } from '../server/db.js';

test('employee codes replace emails, normalize case, preserve leading zeroes and reject duplicates', async () => {
  const f = await fixture();
  try {
    const admin = await f.login('ADMIN');
    const response = await f.send('/api/admin/users', admin, { method: 'POST', body: JSON.stringify({ name: 'Nhân viên kiểm thử', employeeCode: ' nv-0007 ', password: 'Employee-Code-Password-123!' }) });
    assert.equal(response.status, 201); const { id } = await response.json() as { id: string };
    const duplicate = await f.send('/api/admin/users', admin, { method: 'POST', body: JSON.stringify({ name: 'Trùng mã', employeeCode: 'NV-0007', password: 'Employee-Code-Password-123!' }) });
    assert.equal(duplicate.status, 409);
    const login = await fetch(`${f.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: f.config.BASE_URL }, body: JSON.stringify({ employeeCode: 'nv-0007', password: 'Employee-Code-Password-123!' }) });
    assert.equal(login.status, 200); const session = await login.json() as any;
    assert.equal(session.user.employeeCode, 'NV-0007'); assert.equal('email' in session.user, false);
    const update = await f.send(`/api/admin/users/${id}`, admin, { method: 'PATCH', body: JSON.stringify({ employeeCode: '0007' }) });
    assert.equal(update.status, 200);
    const conflict = await f.send(`/api/admin/users/${id}`, admin, { method: 'PATCH', body: JSON.stringify({ employeeCode: 'ADMIN' }) });
    assert.equal(conflict.status, 409);
    const preserved = await fetch(`${f.base}/api/auth/me`, { headers: { Cookie: login.headers.get('set-cookie')!.split(';')[0] } });
    assert.equal(preserved.status, 200); assert.equal((await preserved.json() as any).user.employeeCode, '0007');
    const invalid = await f.send('/api/admin/users', admin, { method: 'POST', body: JSON.stringify({ name: 'Sai mã', employeeCode: 'bad@code', password: 'Employee-Code-Password-123!' }) });
    assert.equal(invalid.status, 400);
  } finally { await f.close(); }
});

test('legacy account migration preserves passwords, roles, sessions and file ownership and is repeatable', async () => {
  const db = new TestDatabase();
  try {
    await migrate(db);
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const [index, email] of ['old-admin@example.com', 'nv001@one.example', 'nv001@two.example'].entries()) {
      await db.query(`INSERT INTO users(id,employee_code,email,name,password_hash,role,quota_bytes) VALUES($1,$2,$3,$4,$5,$6,1000)`, [ids[index], `OLD${index}`, email, `Account ${index}`, `unchanged-hash-${index}`, index === 0 ? 'admin' : 'employee']);
    }
    const fileId = randomUUID();
    await db.query(`INSERT INTO files(id,owner_id,name,source,status,size_bytes,reserved_bytes) VALUES($1,$2,'old.txt','upload','pending',3,3)`, [fileId, ids[1]]);
    await db.query(`INSERT INTO sessions(token_hash,user_id,expires_at) VALUES('existing-session',$1,now()+interval '1 day')`, [ids[1]]);
    await db.query('ALTER TABLE users DROP COLUMN employee_code');
    await db.query('ALTER TABLE users ALTER COLUMN email SET NOT NULL');
    await migrate(db, 'ADMIN');
    const rows = (await db.query<{ id: string; employee_code: string; password_hash: string; role: string }>('SELECT id,employee_code,password_hash,role FROM users ORDER BY id')).rows;
    assert.equal(rows.find(row => row.id === ids[0])?.employee_code, 'ADMIN');
    assert.equal(new Set(rows.map(row => row.employee_code)).size, 3);
    assert.ok(rows.filter(row => row.role === 'employee').every(row => row.employee_code.startsWith('NV001')));
    for (let index = 0; index < ids.length; index++) assert.equal(rows.find(row => row.id === ids[index])?.password_hash, `unchanged-hash-${index}`);
    assert.equal((await db.query<{ owner_id: string }>('SELECT owner_id FROM files WHERE id=$1', [fileId])).rows[0].owner_id, ids[1]);
    assert.equal((await db.query<{ user_id: string }>("SELECT user_id FROM sessions WHERE token_hash='existing-session'")).rows[0].user_id, ids[1]);
    await migrate(db, 'NEW-CONFIG-ADMIN');
    assert.deepEqual((await db.query('SELECT id,employee_code,password_hash,role FROM users ORDER BY id')).rows, rows);
    await db.query(`INSERT INTO users(id,employee_code,name,password_hash,role,quota_bytes) VALUES($1,'NEW001','New','hash','employee',1000)`, [randomUUID()]);
  } finally { await db.close(); }
});

test('localhost alias is allowed only in explicit loopback development, with unchanged CSRF enforcement', async () => {
  const f = await fixture();
  try {
    const body = JSON.stringify({ employeeCode: 'NV001', password: 'Employee-Test-Password-123!' });
    const login = (origin: string) => fetch(`${f.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body });
    assert.equal((await login('http://127.0.0.1:5173')).status, 403);
    f.config.NODE_ENV = 'development';
    const accepted = await login('http://127.0.0.1:5173'); assert.equal(accepted.status, 200);
    for (const origin of ['http://127.0.0.1:5174', 'http://localhost.evil.example:5173', 'https://127.0.0.1:5173', 'null']) assert.equal((await login(origin)).status, 403, origin);
    const csrfMissing = await fetch(`${f.base}/api/files/uploads`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173', Cookie: accepted.headers.get('set-cookie')!.split(';')[0] }, body: JSON.stringify({ name: 'x.txt', size: 1 }) });
    assert.equal(csrfMissing.status, 403);
    f.config.NODE_ENV = 'production';
    assert.equal((await login('http://127.0.0.1:5173')).status, 403);
    f.config.NODE_ENV = 'development'; f.config.BASE_URL = 'https://drive.example.com';
    assert.equal((await login('http://127.0.0.1:5173')).status, 403);
  } finally { await f.close(); }
});
