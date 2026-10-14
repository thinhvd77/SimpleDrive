import assert from 'node:assert/strict';
import { fixture, eventually } from '../tests/helpers.js';
import type { FileRow } from '../server/storage.js';
const f = await fixture({ maxBytes: 1_000_000 });
try {
  const auth = await f.login();
  const response = await f.send('/api/files/imports', auth, { method: 'POST', body: JSON.stringify({ url: 'https://raw.githubusercontent.com/tus/tus-resumable-upload-protocol/main/README.md' }) });
  assert.equal(response.status, 202); const { file } = await response.json() as any;
  await f.db.query(`UPDATE files SET updated_at=now()-interval '3 seconds' WHERE id=$1`, [file.id]);
  await f.worker.tick(); await eventually(async () => (await f.db.query<FileRow>('SELECT * FROM files WHERE id=$1', [file.id])).rows[0].status === 'ready', 30_000);
  const result = (await f.db.query<FileRow>('SELECT * FROM files WHERE id=$1', [file.id])).rows[0];
  const download = await f.send(`/api/files/${file.id}/download`, auth);
  assert.equal(download.status, 200); assert.equal((await download.arrayBuffer()).byteLength, Number(result.size_bytes));
  console.log(JSON.stringify({ publicImport: 'passed', status: result.status, bytes: Number(result.size_bytes), checksum: Boolean(result.sha256) }));
} finally { await f.close(); }
