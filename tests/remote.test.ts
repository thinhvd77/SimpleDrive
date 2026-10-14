import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { fixture, eventually } from './helpers.js';
import { filePath, seal, unseal, type FileRow } from '../server/storage.js';
import { driveReference, isPublicIp, parseRemoteUrl, pinnedLookup, type OpenRemote } from '../server/remote.js';
import { Worker } from '../server/worker.js';
import { createHash } from 'node:crypto';

test('SSRF rejects special networks, mapped addresses, local names and unsafe URL formats', () => {
  for (const ip of ['127.0.0.1','10.0.0.1','172.16.1.1','192.168.1.1','169.254.169.254','0.0.0.0','100.64.0.1','224.0.0.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1']) assert.equal(isPublicIp(ip), false, ip);
  assert.equal(isPublicIp('8.8.8.8'), true); assert.equal(isPublicIp('2606:4700:4700::1111'), true);
  for (const url of ['http://127.0.0.1/a','http://2130706433/','http://0x7f000001/','http://[::1]/','http://localhost/','http://test.local/','file:///tmp/a','https://user:pass@example.com/a','https://example.com:8080/a']) assert.throws(() => parseRemoteUrl(url), undefined, url);
  assert.equal(parseRemoteUrl('https://example.com/file.zip#x').href, 'https://example.com/file.zip');
});
test('Google Drive file parsing and encrypted import URL storage', () => {
  assert.deepEqual(driveReference(new URL('https://drive.google.com/file/d/abcdefghijk/view?resourcekey=abc-123')), { id: 'abcdefghijk', resourceKey: 'abc-123' });
  assert.throws(() => driveReference(new URL('https://drive.google.com/drive/folders/abcdefghijk')));
  const encrypted = seal('https://example.com/file?token=private', 'secret');
  assert.equal(unseal(encrypted, 'secret'), 'https://example.com/file?token=private');
  assert.throws(() => unseal(encrypted, 'wrong-secret'));
});
test('pinned DNS lookup supports both Node single-address and autoSelectFamily callbacks', () => {
  const lookup = pinnedLookup({ address: '8.8.8.8', family: 4 });
  lookup('example.com', {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4); });
  lookup('example.com', { all: true }, ((error: null, addresses: unknown) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]); }) as any);
});
const remote = (content: Buffer, headers: Record<string, string> = {}): OpenRemote => async url => ({ body: (async function* () { yield content.subarray(0, 5); yield content.subarray(5); })(), headers, finalUrl: url, close: async () => {} });
test('background import streams a public file, publishes checksum and releases excess reservation', async () => {
  const content = Buffer.from('downloaded file bytes');
  const f = await fixture({ maxBytes: 100, open: remote(content, { 'content-length': String(content.length), 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="real.txt"' }) });
  try {
    const auth = await f.login(); const response = await f.send('/api/files/imports', auth, { method: 'POST', body: JSON.stringify({ url: 'https://example.com/file' }) }); assert.equal(response.status, 202);
    const { file } = await response.json() as any;
    const privateRow = (await f.db.query<FileRow>('SELECT * FROM files WHERE id=$1', [file.id])).rows[0]; assert.notEqual(privateRow.source_url, 'https://example.com/file');
    await f.db.query(`UPDATE files SET updated_at=now()-interval '3 seconds' WHERE id=$1`, [file.id]); await f.worker.tick();
    await eventually(async () => (await f.db.query<FileRow>('SELECT * FROM files WHERE id=$1', [file.id])).rows[0].status === 'ready');
    assert.deepEqual(await readFile(filePath(f.config, file.id)), content);
    const row = (await f.db.query<FileRow>('SELECT * FROM files WHERE id=$1', [file.id])).rows[0]; assert.equal(row.name, 'real.txt'); assert.equal(Number(row.reserved_bytes), content.length); assert.equal(row.source_url, null); assert.ok(row.sha256);
  } finally { await f.close(); }
});
test('unknown-length import exceeding actual-byte limit fails and deletes partial data', async () => {
  const f = await fixture({ maxBytes: 16, open: remote(Buffer.alloc(17)) });
  try {
    const auth = await f.login(); const { file } = await (await f.send('/api/files/imports', auth, { method: 'POST', body: JSON.stringify({ url: 'https://example.com/large' }) })).json() as any;
    await f.db.query(`UPDATE files SET updated_at=now()-interval '3 seconds' WHERE id=$1`, [file.id]); await f.worker.tick();
    await eventually(async () => (await f.db.query<FileRow>('SELECT * FROM files WHERE id=$1', [file.id])).rows[0].status === 'failed');
    await assert.rejects(stat(filePath(f.config, file.id) + '.part')); const row = (await f.db.query<FileRow>('SELECT * FROM files WHERE id=$1', [file.id])).rows[0]; assert.equal(Number(row.reserved_bytes), 0);
  } finally { await f.close(); }
});
test('HTML response fails rather than being treated as a successful file', async () => {
  const f = await fixture({ open: remote(Buffer.from('<html>login</html>'), { 'content-type': 'text/html' }) });
  try {
    const auth = await f.login(); const { file } = await (await f.send('/api/files/imports', auth, { method: 'POST', body: JSON.stringify({ url: 'https://example.com/login' }) })).json() as any;
    await f.db.query(`UPDATE files SET updated_at=now()-interval '3 seconds' WHERE id=$1`, [file.id]); await f.worker.tick();
    await eventually(async () => (await f.db.query<FileRow>('SELECT * FROM files WHERE id=$1', [file.id])).rows[0].status === 'failed');
  } finally { await f.close(); }
});
test('graceful restart preserves an import reservation and allows the next worker to recover', async () => {
  const slow: OpenRemote = async (url, _headers, signal) => ({
    body: (async function* () {
      signal?.throwIfAborted(); yield Buffer.from('hello');
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) { reject(new Error('Stopped')); return; }
        signal?.addEventListener('abort', () => reject(new Error('Stopped')), { once: true });
      });
    })(), headers: {}, finalUrl: url, close: async () => {},
  });
  const f = await fixture({ maxBytes: 100, open: slow }); let next: Worker | undefined;
  try {
    const auth = await f.login(); const { file } = await (await f.send('/api/files/imports', auth, { method: 'POST', body: JSON.stringify({ url: 'https://example.com/restart.bin' }) })).json() as any;
    await f.db.query(`UPDATE files SET updated_at=now()-interval '3 seconds' WHERE id=$1`, [file.id]);
    await f.worker.tick(); await f.worker.stop();
    const paused = (await f.db.query<FileRow>('SELECT * FROM files WHERE id=$1', [file.id])).rows[0]; assert.equal(paused.status, 'queued'); assert.equal(Number(paused.reserved_bytes), 100);
    next = new Worker(f.db, f.config, { open: remote(Buffer.from('recovered')) });
    await f.db.query(`UPDATE files SET updated_at=now()-interval '3 seconds' WHERE id=$1`, [file.id]);
    await next.tick(); await eventually(async () => (await f.db.query<FileRow>('SELECT * FROM files WHERE id=$1', [file.id])).rows[0].status === 'ready');
    assert.equal((await readFile(filePath(f.config, file.id))).toString(), 'recovered');
  } finally { await next?.stop(); await f.close(); }
});
test('public Google Drive adapter uses API key/resource key and verifies source metadata and MD5', async () => {
  const content = Buffer.from('public Google Drive file'); const calls: { url: URL; headers: Record<string,string> }[] = [];
  const open: OpenRemote = async (url, headers = {}, signal) => {
    const parsed = new URL(url); calls.push({ url: parsed, headers });
    const data = parsed.searchParams.has('fields') ? Buffer.from(JSON.stringify({ name: 'Tài liệu.txt', size: String(content.length), mimeType: 'text/plain', md5Checksum: createHash('md5').update(content).digest('hex') })) : content;
    return remote(data, { 'content-length': String(data.length) })(url, headers, signal);
  };
  const f = await fixture({ open }); f.config.GOOGLE_DRIVE_API_KEY = 'test-key';
  try {
    const auth = await f.login(); const result = await f.send('/api/files/imports', auth, { method: 'POST', body: JSON.stringify({ url: 'https://drive.google.com/file/d/abcdefghijk/view?resourcekey=public-key' }) }); assert.equal(result.status, 202);
    const { file } = await result.json() as any; await f.db.query(`UPDATE files SET updated_at=now()-interval '3 seconds' WHERE id=$1`, [file.id]); await f.worker.tick();
    await eventually(async () => (await f.db.query<FileRow>('SELECT * FROM files WHERE id=$1', [file.id])).rows[0].status === 'ready');
    assert.equal(calls.length, 2); assert.equal(calls[0].url.hostname, 'www.googleapis.com'); assert.equal(calls[0].url.searchParams.get('key'), 'test-key'); assert.equal(calls[0].headers['X-Goog-Drive-Resource-Keys'], 'abcdefghijk/public-key'); assert.equal(calls[1].url.searchParams.get('alt'), 'media');
    const row = (await f.db.query<FileRow>('SELECT * FROM files WHERE id=$1', [file.id])).rows[0]; assert.equal(row.name, 'Tài liệu.txt'); assert.equal(Number(row.size_bytes), content.length);
  } finally { await f.close(); }
});
