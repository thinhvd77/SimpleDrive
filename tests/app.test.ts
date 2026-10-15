import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, stat, writeFile } from 'node:fs/promises';
import { fixture, eventually } from './helpers.js';
import { filePath, type FileRow } from '../server/storage.js';

test('login, CSRF, account boundaries and disabling invalidates sessions', async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(`${f.base}/api/files`)).status, 401);
    const auth = await f.login(); const admin = await f.login('ADMIN');
    assert.equal((await f.send('/api/admin/users', auth)).status, 403);
    assert.equal((await fetch(`${f.base}/api/files/uploads`, { method: 'POST', headers: { Cookie: auth.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x', size: 1 }) })).status, 403);
    assert.equal((await f.send('/api/files/uploads', auth, { method: 'POST', headers: { Origin: 'https://evil.example' }, body: JSON.stringify({ name: 'x', size: 1 }) })).status, 403);
    const reserved = await (await f.send('/api/files/uploads', auth, { method: 'POST', body: JSON.stringify({ name: 'a.txt', size: 1 }) })).json() as any;
    const other = await f.login('NV002');
    assert.equal((await f.send(`/api/files/${reserved.file.id}`, other)).status, 404);
    assert.equal((await f.send(`/api/files/${reserved.file.id}/download`, other)).status, 404);
    assert.equal((await f.send(`/api/files/${reserved.file.id}`, other, { method: 'DELETE' })).status, 404);
    assert.equal((await f.send(`/api/admin/users/${auth.id}`, admin, { method: 'PATCH', body: JSON.stringify({ disabled: true }) })).status, 200);
    assert.equal((await f.send('/api/files', auth)).status, 401);
  } finally { await f.close(); }
});

test('resumable upload, verification, checksum, full and ranged download, delete cleanup', async () => {
  const f = await fixture();
  try {
    const auth = await f.login(); const other = await f.login('NV002');
    const content = Buffer.from('hello simpledrive');
    const reserve = await f.send('/api/files/uploads', auth, { method: 'POST', body: JSON.stringify({ name: 'Báo cáo.txt', size: content.length }) });
    assert.equal(reserve.status, 201); const { file } = await reserve.json() as any;
    const create = await f.send('/api/uploads', auth, { method: 'POST', headers: { 'Tus-Resumable': '1.0.0', 'Upload-Length': String(content.length), 'Upload-Metadata': `fileId ${Buffer.from(file.id).toString('base64')}` } });
    assert.equal(create.status, 201, await create.text()); const location = create.headers.get('location')!;
    assert.equal((await f.send(location, other, { method: 'HEAD', headers: { 'Tus-Resumable': '1.0.0' } })).status, 404);
    const first = await f.send(location, auth, { method: 'PATCH', headers: { 'Tus-Resumable': '1.0.0', 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' }, body: content.subarray(0, 5) });
    assert.equal(first.status, 204, await first.text());
    const head = await f.send(location, auth, { method: 'HEAD', headers: { 'Tus-Resumable': '1.0.0' } });
    assert.equal(head.headers.get('upload-offset'), '5');
    const wrongOffset = await f.send(location, auth, { method: 'PATCH', headers: { 'Tus-Resumable': '1.0.0', 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' }, body: Buffer.from('xx') });
    assert.equal(wrongOffset.status, 409);
    const rest = await f.send(location, auth, { method: 'PATCH', headers: { 'Tus-Resumable': '1.0.0', 'Upload-Offset': '5', 'Content-Type': 'application/offset+octet-stream' }, body: content.subarray(5) });
    assert.equal(rest.status, 204, await rest.text());
    assert.equal((await f.send(`/api/files/${file.id}/download`, auth)).status, 409);
    await f.worker.tick(); await eventually(async () => (await f.db.query<FileRow>('SELECT * FROM files WHERE id=$1', [file.id])).rows[0].status === 'ready');
    const full = await f.send(`/api/files/${file.id}/download`, auth); assert.equal(full.status, 200); assert.deepEqual(Buffer.from(await full.arrayBuffer()), content);
    const metadata = await (await f.send(`/api/files/${file.id}`, auth)).json() as any;
    assert.equal(metadata.file.sha256, createHash('sha256').update(content).digest('hex'));
    const partial = await f.send(`/api/files/${file.id}/download`, auth, { headers: { Range: 'bytes=6-11' } }); assert.equal(partial.status, 206); assert.equal(await partial.text(), content.subarray(6, 12).toString());
    assert.equal(partial.headers.get('content-range'), `bytes 6-11/${content.length}`);
    const suffix = await f.send(`/api/files/${file.id}/download`, auth, { headers: { Range: 'bytes=-5' } }); assert.equal(await suffix.text(), content.subarray(-5).toString());
    assert.equal((await f.send(`/api/files/${file.id}/download`, auth, { headers: { Range: 'bytes=1000-' } })).status, 416);
    assert.equal((await f.send(`/api/files/${file.id}`, auth, { method: 'DELETE' })).status, 202);
    await f.worker.cleanup(); await assert.rejects(access(filePath(f.config, file.id)));
    const removed = await f.db.query<FileRow>('SELECT * FROM files WHERE id=$1', [file.id]); assert.equal(removed.rows[0].status, 'deleted'); assert.equal(Number(removed.rows[0].reserved_bytes), 0);
  } finally { await f.close(); }
});

test('2 GB boundary, quota reservation and invalid download before file is ready', async () => {
  const f = await fixture();
  try {
    const auth = await f.login();
    const exact = await f.send('/api/files/uploads', auth, { method: 'POST', body: JSON.stringify({ name: '2gb.bin', size: 2_000_000_000 }) }); assert.equal(exact.status, 201);
    assert.equal((await f.send('/api/files/uploads', auth, { method: 'POST', body: JSON.stringify({ name: 'too-big.bin', size: 2_000_000_001 }) })).status, 413);
    const file = (await exact.json() as any).file;
    const corrupt = await f.send('/api/uploads', auth, { method: 'POST', headers: { 'Tus-Resumable': '1.0.0', 'Upload-Length': '1', 'Upload-Metadata': `fileId ${Buffer.from(file.id).toString('base64')}` } }); assert.equal(corrupt.status, 409);
    await f.db.query('UPDATE users SET quota_bytes=$2 WHERE id=$1', [auth.id, 2_000_000_000]);
    assert.equal((await f.send('/api/files/uploads', auth, { method: 'POST', body: JSON.stringify({ name: 'extra', size: 1 }) })).status, 409);
    assert.equal((await f.send(`/api/files/${file.id}/download`, auth)).status, 409);
  } finally { await f.close(); }
});

test('expiry and abandoned upload cleanup release capacity', async () => {
  const f = await fixture();
  try {
    const auth = await f.login();
    const { file } = await (await f.send('/api/files/uploads', auth, { method: 'POST', body: JSON.stringify({ name: 'old.bin', size: 4 }) })).json() as any;
    await writeFile(filePath(f.config, file.id), 'test');
    await f.db.query(`UPDATE files SET status='ready',expires_at=now()-interval '1 hour' WHERE id=$1`, [file.id]);
    assert.equal((await f.send(`/api/files/${file.id}/download`, auth)).status, 409);
    await f.worker.cleanup(); assert.equal((await f.db.query<FileRow>('SELECT * FROM files WHERE id=$1', [file.id])).rows[0].status, 'expired'); await assert.rejects(stat(filePath(f.config, file.id)));
    const idle = await (await f.send('/api/files/uploads', auth, { method: 'POST', body: JSON.stringify({ name: 'abandoned.bin', size: 9 }) })).json() as any;
    await f.db.query(`UPDATE files SET updated_at=now()-interval '25 hours' WHERE id=$1`, [idle.file.id]);
    await f.worker.cleanup(); assert.equal((await f.db.query<FileRow>('SELECT * FROM files WHERE id=$1', [idle.file.id])).rows[0].status, 'expired');
  } finally { await f.close(); }
});
test('concurrent global quota reservations stay within budget; low disk space rejects new files', async () => {
  const f = await fixture(); f.config.GLOBAL_QUOTA_BYTES = 3;
  try {
    const auth = await f.login();
    const responses = await Promise.all([1,2,3].map(n => f.send('/api/files/uploads', auth, { method: 'POST', body: JSON.stringify({ name: `${n}.bin`, size: 2 }) })));
    assert.deepEqual(responses.map(r => r.status).sort(), [201,507,507]);
    const used = await f.db.query<{ used: string }>('SELECT sum(reserved_bytes) AS used FROM files'); assert.equal(Number(used.rows[0].used), 2);
    f.config.GLOBAL_QUOTA_BYTES = 100; f.config.MIN_FREE_BYTES = Number.MAX_SAFE_INTEGER;
    assert.equal((await f.send('/api/files/uploads', auth, { method: 'POST', body: JSON.stringify({ name: 'no-disk-space.bin', size: 1 }) })).status, 507);
  } finally { await f.close(); }
});

test('eight-character passwords work for create, reset and change; seven characters are rejected', async () => {
  const f = await fixture();
  try {
    const admin = await f.login('ADMIN');
    const create = (password: string) => f.send('/api/admin/users', admin, { method: 'POST', body: JSON.stringify({ employeeCode: 'NV008', name: 'Password boundary', password }) });
    assert.equal((await create('Short12')).status, 400);
    const created = await create('Start123'); assert.equal(created.status, 201);
    const { id } = await created.json() as { id: string };
    const login = async (password: string) => {
      const response = await fetch(`${f.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: f.config.BASE_URL }, body: JSON.stringify({ employeeCode: 'NV008', password }) });
      assert.equal(response.status, 200);
      const body = await response.json() as { csrf: string };
      return { id, csrf: body.csrf, cookie: response.headers.get('set-cookie')!.split(';')[0] };
    };
    await login('Start123');
    assert.equal((await f.send(`/api/admin/users/${id}`, admin, { method: 'PATCH', body: JSON.stringify({ password: 'Short12' }) })).status, 400);
    assert.equal((await f.send(`/api/admin/users/${id}`, admin, { method: 'PATCH', body: JSON.stringify({ password: 'Reset123' }) })).status, 200);
    const employee = await login('Reset123');
    assert.equal((await f.send('/api/auth/password', employee, { method: 'POST', body: JSON.stringify({ currentPassword: 'Reset123', password: 'Short12' }) })).status, 400);
    assert.equal((await f.send('/api/auth/password', employee, { method: 'POST', body: JSON.stringify({ currentPassword: 'Reset123', password: 'NewPass1' }) })).status, 200);
    assert.equal((await f.send('/api/auth/me', employee)).status, 401);
    await login('NewPass1');
  } finally { await f.close(); }
});
