import { createWriteStream } from 'node:fs';
import { rename, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createHash } from 'node:crypto';
import type { Config } from './config.js';
import type { Database } from './db.js';
import { HttpError } from './auth.js';
import { checksums, cleanName, filePath, removeBytes, unseal, type FileRow, audit } from './storage.js';
import { openRemote, resolveSource, type OpenRemote } from './remote.js';

export class Worker {
  private timer?: NodeJS.Timeout;
  private tasks = new Map<string, { controller: AbortController; promise: Promise<void>; kind: string }>();
  private ticking = false;
  private stopping = false;
  constructor(private db: Database, private config: Config, private options: { open?: OpenRemote; activeUploads?: Set<string>; onError?: (error: unknown) => void } = {}) {}
  start() { this.timer = setInterval(() => { void this.tick().catch(e => this.report(e)); }, 2000); this.timer.unref(); void this.tick().catch(e => this.report(e)); }
  private report(e: unknown) { this.options.onError?.(e); }
  async stop() {
    this.stopping = true; clearInterval(this.timer);
    while (this.ticking) await new Promise(resolve => setTimeout(resolve, 10));
    for (const task of this.tasks.values()) task.controller.abort();
    await Promise.allSettled([...this.tasks.values()].map(t => t.promise));
  }
  async tick() {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      await this.db.query(`UPDATE files SET status='queued', lease_until=NULL, updated_at=now()
        WHERE status='downloading' AND lease_until<now()`);
      await this.cleanup();
      // Recover a crash after writing the last byte but before the tus finish hook.
      const uploads = await this.db.query<FileRow>(`SELECT * FROM files WHERE status='uploading' AND updated_at<now()-interval '10 seconds' LIMIT 20`);
      for (const f of uploads.rows) {
        if (this.options.activeUploads?.has(f.id)) continue;
        try {
          const bytes = (await stat(filePath(this.config, f.id))).size;
          if (bytes === Number(f.size_bytes)) await this.db.query(`UPDATE files SET status='verifying',received_bytes=size_bytes,updated_at=now() WHERE id=$1 AND status='uploading'`, [f.id]);
        } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      }
      for (const kind of ['verifying', 'queued']) {
        const limit = kind === 'queued' ? this.config.IMPORT_CONCURRENCY : 1;
        const active = [...this.tasks.values()].filter(t => t.kind === kind).length;
        for (let n = active; n < limit && !this.stopping; n++) {
          const row = await this.claim(kind); if (!row) break;
          const controller = new AbortController();
          const promise = this.run(row, kind, controller).catch(e => this.report(e)).finally(() => this.tasks.delete(row.id));
          this.tasks.set(row.id, { controller, promise, kind });
        }
      }
    } finally { this.ticking = false; }
  }
  private async claim(kind: string) {
    return this.db.transaction(async tx => {
      const row = await tx.query<FileRow>(`SELECT * FROM files WHERE status=$1 AND (lease_until IS NULL OR lease_until<now())
        AND ($1!='queued' OR updated_at<now()-interval '2 seconds') ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`, [kind]);
      const f = row.rows[0]; if (!f) return null;
      await tx.query(`UPDATE files SET status=$2,lease_until=now()+interval '2 minutes',attempts=attempts+1 WHERE id=$1`, [f.id, kind === 'queued' ? 'downloading' : 'verifying']);
      return f;
    });
  }
  private async run(f: FileRow, kind: string, controller: AbortController) {
    const status = kind === 'queued' ? 'downloading' : 'verifying';
    let heartbeatBusy = false;
    const heartbeat = setInterval(() => {
      if (heartbeatBusy) return; heartbeatBusy = true;
      void this.db.query(`UPDATE files SET lease_until=now()+interval '2 minutes',updated_at=now() WHERE id=$1 AND status=$2 RETURNING id`, [f.id, status])
        .then(r => { if (!r.rows.length) controller.abort(); }).catch(e => { this.report(e); controller.abort(); }).finally(() => { heartbeatBusy = false; });
    }, 1000);
    try {
      if (kind === 'queued') await this.download(f, controller.signal);
      else await this.verify(f, controller.signal);
    } catch (error) {
      const current = await this.db.query<{ status: string }>('SELECT status FROM files WHERE id=$1', [f.id]);
      // Never delete a published file because a later audit/connection-close operation failed.
      if (current.rows[0]?.status === 'ready') { this.report(new Error('Post-completion operation failed.')); return; }
      if (this.stopping && controller.signal.aborted && current.rows[0]?.status !== 'deleting') {
        if (kind === 'queued') await removeBytes(this.config, f.id);
        await this.db.query(`UPDATE files SET status=$2,lease_until=NULL,attempts=GREATEST(attempts-1,0),
          received_bytes=CASE WHEN $2='queued' THEN 0 ELSE received_bytes END,updated_at=now()
          WHERE id=$1 AND status IN ('downloading','verifying')`, [f.id, kind]);
        return;
      }
      await removeBytes(this.config, f.id);
      const message = error instanceof HttpError ? error.message : controller.signal.aborted ? 'Tác vụ bị gián đoạn.' : 'Không thể xử lý file. Kiểm tra nguồn tải hoặc thử lại.';
      const retry = kind === 'queued' && !(error instanceof HttpError) && f.attempts < 2 && !controller.signal.aborted;
      await this.db.query(`UPDATE files SET status=$3,error=$2,lease_until=NULL,received_bytes=0,reserved_bytes=CASE WHEN $3='queued' THEN reserved_bytes ELSE 0 END,updated_at=now()
        WHERE id=$1 AND status IN ('downloading','verifying')`, [f.id, message, retry ? 'queued' : 'failed']);
      if (!(error instanceof HttpError) && !controller.signal.aborted) this.report(new Error('File worker failed (source URLs and credentials omitted).'));
    } finally {
      clearInterval(heartbeat);
      while (heartbeatBusy) await new Promise(resolve => setTimeout(resolve, 10));
      await this.db.query('UPDATE files SET lease_until=NULL WHERE id=$1', [f.id]);
    }
  }
  private async download(f: FileRow, signal: AbortSignal) {
    const source = await resolveSource(unseal(f.source_url!, this.config.SESSION_SECRET), this.config, this.options.open, signal);
    const remote = await (this.options.open ?? openRemote)(source.url, source.headers, signal);
    try {
      const type = String(remote.headers['content-type'] ?? '').toLowerCase();
      if (type.includes('text/html') || type.includes('application/xhtml')) throw new HttpError(400, 'Link trả về trang web. Hãy dùng link tải trực tiếp của file.');
      const length = remote.headers['content-length'];
      const headerSize = length === undefined ? null : Number(length);
      const expected = source.size ?? headerSize;
      if (source.size !== null && headerSize !== null && source.size !== headerSize) throw new HttpError(400, 'Dung lượng nguồn tải không khớp với metadata.');
      if (expected !== null && (!Number.isSafeInteger(expected) || expected < 1 || expected > this.config.MAX_FILE_BYTES)) throw new HttpError(413, 'Nguồn tải có dung lượng không hợp lệ hoặc vượt 2 GB.');
      const disposition = String(remote.headers['content-disposition'] ?? '');
      const match = /filename\*=UTF-8''([^;]+)/i.exec(disposition) ?? /filename="([^"\r\n]+)"/i.exec(disposition);
      let name = source.name ?? f.name;
      if (!source.name && match) { try { name = decodeURIComponent(match[1]); } catch { name = match[1]; } }
      name = cleanName(name);
      const sha = createHash('sha256'), md5 = createHash('md5'); let received = 0, lastUpdate = Date.now();
      const meter = new Transform({ transform: (chunk: Buffer, _encoding, callback) => {
        received += chunk.length;
        if (received > this.config.MAX_FILE_BYTES || received > Number(f.reserved_bytes)) { callback(new HttpError(413, 'File thực nhận vượt giới hạn 2 GB.')); return; }
        sha.update(chunk); md5.update(chunk);
        const update = Date.now() - lastUpdate >= 1000;
        if (update) {
          lastUpdate = Date.now();
          void this.db.query(`UPDATE files SET received_bytes=$2,size_bytes=$3,updated_at=now() WHERE id=$1 AND status='downloading' RETURNING id`, [f.id, received, expected ?? 0])
            .then(r => { if (!r.rows.length) callback(new Error('Cancelled')); else callback(null, chunk); }).catch(callback);
        } else callback(null, chunk);
      } });
      await pipeline(remote.body, meter, createWriteStream(filePath(this.config, f.id) + '.part', { mode: 0o640 }), { signal });
      if (received === 0 || (expected !== null && expected !== received)) throw new HttpError(400, 'Nguồn tải bị ngắt trước khi truyền đủ dữ liệu.');
      const actualMd5 = md5.digest('hex');
      if (source.md5 && actualMd5 !== source.md5) throw new HttpError(400, 'Checksum của file không khớp với nguồn.');
      signal.throwIfAborted();
      await rename(filePath(this.config, f.id) + '.part', filePath(this.config, f.id));
      const result = await this.db.query(`UPDATE files SET status='ready',name=$2,size_bytes=$3,reserved_bytes=$3,received_bytes=$3,sha256=$4,source_url=NULL,error=NULL,
        expires_at=now()+($5 * interval '1 hour'),updated_at=now() WHERE id=$1 AND status='downloading' RETURNING id`, [f.id, name, received, sha.digest('hex'), this.config.RETENTION_HOURS]);
      if (!result.rows.length) throw new Error('Cancelled');
      await audit(this.db, f.owner_id, 'import_ready', f.id);
    } finally { await remote.close(); }
  }
  private async verify(f: FileRow, signal: AbortSignal) {
    const bytes = (await stat(filePath(this.config, f.id))).size;
    if (bytes !== Number(f.size_bytes) || bytes > this.config.MAX_FILE_BYTES) throw new HttpError(400, 'Dung lượng file thực nhận không khớp.');
    const hash = await checksums(this.config, f.id, signal); signal.throwIfAborted();
    if (f.expected_md5 && hash.md5 !== f.expected_md5) throw new HttpError(400, 'Checksum không khớp.');
    const result = await this.db.query(`UPDATE files SET status='ready',sha256=$2,reserved_bytes=size_bytes,received_bytes=size_bytes,
      expires_at=now()+($3 * interval '1 hour'),updated_at=now(),error=NULL WHERE id=$1 AND status='verifying' RETURNING id`, [f.id, hash.sha256, this.config.RETENTION_HOURS]);
    if (!result.rows.length) throw new Error('Cancelled');
    await audit(this.db, f.owner_id, 'upload_ready', f.id);
  }
  async cleanup() {
    await this.db.query(`UPDATE files SET status='deleting',error='expired',updated_at=now() WHERE
      (status='ready' AND expires_at<=now()) OR
      (status IN ('pending','uploading') AND updated_at<now()-($1*interval '1 hour'))`, [this.config.UPLOAD_IDLE_HOURS]);
    const rows = await this.db.query<FileRow>(`SELECT * FROM files WHERE status='deleting' AND (lease_until IS NULL OR lease_until<now()) LIMIT 50`);
    for (const f of rows.rows) {
      if (this.tasks.has(f.id) || this.options.activeUploads?.has(f.id)) continue;
      await removeBytes(this.config, f.id);
      await this.db.query(`UPDATE files SET status=$2,reserved_bytes=0,received_bytes=0,source_url=NULL,updated_at=now() WHERE id=$1 AND status='deleting'`, [f.id, f.error === 'expired' ? 'expired' : 'deleted']);
      await audit(this.db, f.owner_id, f.error === 'expired' ? 'file_expired' : 'file_deleted', f.id);
    }
    await this.db.query('DELETE FROM sessions WHERE expires_at<=now()');
    await this.db.query(`DELETE FROM audit WHERE created_at<now()-interval '90 days'`);
    await this.db.query(`DELETE FROM files WHERE status IN ('deleted','expired','failed') AND reserved_bytes=0 AND updated_at<now()-interval '30 days'`);
  }
}
