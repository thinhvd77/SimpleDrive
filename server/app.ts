import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { Server as TusServer } from '@tus/server';
import { FileStore } from '@tus/file-store';
import { randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { type Config } from './config.js';
import { type Database } from './db.js';
import { HttpError, authenticate, assertOrigin, hashPassword, checkPassword, csrfToken, tokenHash, type User } from './auth.js';
import { initializeStorage, ownedFile, reserveFile, publicFile, filePath, audit, validId, type FileRow } from './storage.js';
import { parseRemoteUrl, driveReference, type OpenRemote } from './remote.js';
import { Worker } from './worker.js';
import { employeeCodeSchema } from './employee-code.js';

const loginSchema = z.object({ employeeCode: employeeCodeSchema, password: z.string().min(1).max(256) });
const passwordSchema = z.string().min(8, 'Mật khẩu cần ít nhất 8 ký tự.').max(256);
const userSchema = z.object({ employeeCode: employeeCodeSchema, name: z.string().trim().min(1).max(100), password: passwordSchema, quota: z.number().int().positive().optional() });
const userUpdate = z.object({ employeeCode: employeeCodeSchema.optional(), disabled: z.boolean().optional(), password: passwordSchema.optional(), quota: z.number().int().positive().optional() });
const summary = (u: User) => ({ id: u.id, employeeCode: u.employee_code, name: u.name, role: u.role, quota: Number(u.quota_bytes), disabled: u.disabled });
export async function createApp(db: Database, config: Config, options: { worker?: boolean; open?: OpenRemote; logger?: boolean } = {}) {
  await initializeStorage(config);
  const app = Fastify({ logger: options.logger ? { redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]'] } : false, bodyLimit: 32 * 1024, requestTimeout: 120_000, trustProxy: config.NGINX_DOWNLOADS === 'true' ? (_address, hop) => hop === 0 : false });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  app.addHook('onRequest', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('X-Frame-Options', 'DENY').header('Referrer-Policy', 'no-referrer')
      .header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ message: error.issues[0]?.message ?? 'Dữ liệu không hợp lệ.' });
    if (error instanceof HttpError) return reply.code(error.statusCode).send({ message: error.message });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return reply.code(status).send({ message: status === 429 ? 'Quá nhiều yêu cầu. Vui lòng thử lại sau.' : 'Yêu cầu không hợp lệ.' });
    app.log.error('An internal operation failed; private payload and credentials are omitted.');
    return reply.code(500).send({ message: 'Có lỗi xử lý. Vui lòng thử lại.' });
  });
  async function user(req: FastifyRequest, mutation = false) { return authenticate(db, req, config, mutation); }
  async function admin(req: FastifyRequest, mutation = false) { const u = await user(req, mutation); if (u.role !== 'admin') throw new HttpError(403, 'Chỉ quản trị viên được thực hiện thao tác này.'); return u; }
  const activeUploads = new Set<string>();
  const worker = new Worker(db, config, { open: options.open, activeUploads, onError: () => app.log.error('Background task failed; credentials and source URLs are omitted.') });
  app.addHook('onClose', async () => { await worker.stop(); });

  app.get('/api/health', async (_req, reply) => {
    try { await db.query('SELECT 1'); await stat(config.DATA_DIR); return { ok: true }; }
    catch { return reply.code(503).send({ ok: false }); }
  });
  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    assertOrigin(req, config);
    const input = loginSchema.parse(req.body);
    const row = await db.query<User & { password_hash: string }>('SELECT * FROM users WHERE employee_code=$1', [input.employeeCode]);
    const u = row.rows[0];
    // Spend the same KDF effort for unknown accounts to reduce account enumeration.
    const dummy = '00000000000000000000000000000000:' + '00'.repeat(64);
    const correct = await checkPassword(input.password, u?.password_hash ?? dummy);
    if (!u || u.disabled || !correct) throw new HttpError(401, 'Mã nhân viên hoặc mật khẩu không đúng.');
    const token = randomBytes(32).toString('hex');
    await db.query(`INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '24 hours')`, [tokenHash(token), u.id]);
    reply.setCookie('sd_session', token, { path: '/', httpOnly: true, sameSite: 'strict', secure: config.secureCookies, maxAge: 86400 });
    reply.header('Cache-Control', 'no-store');
    await audit(db, u.id, 'login');
    return { user: summary(u), csrf: csrfToken(token, config.SESSION_SECRET) };
  });
  app.get('/api/auth/me', async (req, reply) => {
    const u = await user(req); reply.header('Cache-Control', 'no-store');
    return { user: summary(u), csrf: csrfToken(req.cookies.sd_session!, config.SESSION_SECRET), limits: { maxFileBytes: config.MAX_FILE_BYTES, retentionHours: config.RETENTION_HOURS, driveEnabled: Boolean(config.GOOGLE_DRIVE_API_KEY) } };
  });
  app.post('/api/auth/logout', async (req, reply) => {
    await user(req, true);
    await db.query('DELETE FROM sessions WHERE token_hash=$1', [tokenHash(req.cookies.sd_session!)]);
    reply.clearCookie('sd_session', { path: '/' }); return { ok: true };
  });
  app.post('/api/auth/password', async req => {
    const u = await user(req, true);
    const input = z.object({ currentPassword: z.string().min(1).max(256), password: passwordSchema }).parse(req.body);
    const row = await db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=$1', [u.id]);
    if (!await checkPassword(input.currentPassword, row.rows[0].password_hash)) throw new HttpError(400, 'Mật khẩu hiện tại không đúng.');
    const hash = await hashPassword(input.password);
    await db.transaction(async tx => { await tx.query('UPDATE users SET password_hash=$2 WHERE id=$1', [u.id, hash]); await tx.query('DELETE FROM sessions WHERE user_id=$1', [u.id]); await audit(tx, u.id, 'password_changed'); });
    return { ok: true };
  });
  app.get('/api/files', async (req, reply) => {
    const u = await user(req); const all = (req.query as { all?: string }).all === 'true' && u.role === 'admin';
    const rows = await db.query<FileRow>(`SELECT * FROM files WHERE (owner_id=$1 OR $2=true) AND status NOT IN ('deleted','expired') ORDER BY created_at DESC LIMIT 300`, [u.id, all]);
    const usage = await db.query<{ used: string }>('SELECT COALESCE(sum(reserved_bytes),0) AS used FROM files WHERE owner_id=$1', [u.id]);
    reply.header('Cache-Control', 'no-store');
    return { files: rows.rows.map(publicFile), used: Number(usage.rows[0].used), quota: Number(u.quota_bytes) };
  });
  app.post('/api/files/uploads', async (req, reply) => {
    const u = await user(req, true);
    const input = z.object({ name: z.string().min(1).max(1000), size: z.number().int().positive() }).parse(req.body);
    const row = await reserveFile(db, config, u, { ...input, source: 'upload' });
    return reply.code(201).send({ file: publicFile(row) });
  });
  app.get<{ Params: { id: string } }>('/api/files/:id', async (req, reply) => {
    const u = await user(req); reply.header('Cache-Control', 'no-store');
    return { file: publicFile(await ownedFile(db, req.params.id, u)) };
  });
  app.post('/api/files/imports', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = await user(req, true);
    const input = z.object({ url: z.string().min(1).max(8192) }).parse(req.body);
    const url = parseRemoteUrl(input.url); const drive = driveReference(url);
    if (drive && !config.GOOGLE_DRIVE_API_KEY) throw new HttpError(503, 'Chưa cấu hình Google Drive API. Hãy upload file hoặc dùng link tải trực tiếp.');
    let name = 'file-từ-link';
    try { name = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? name); } catch { /* fallback name */ }
    const row = await reserveFile(db, config, u, { name: drive ? 'File Google Drive' : name, size: config.MAX_FILE_BYTES, source: drive ? 'drive' : 'url', url: url.href });
    return reply.code(202).send({ file: publicFile(row) });
  });
  app.delete<{ Params: { id: string } }>('/api/files/:id', async (req, reply) => {
    const u = await user(req, true); const f = await ownedFile(db, req.params.id, u);
    await db.transaction(async tx => { await tx.query(`UPDATE files SET status='deleting',error=NULL,updated_at=now() WHERE id=$1 AND status NOT IN ('deleted','expired')`, [f.id]); await audit(tx, u.id, 'delete_requested', f.id); });
    return reply.code(202).send({ ok: true });
  });
  app.get<{ Params: { id: string } }>('/api/files/:id/download', async (req, reply) => {
    const u = await user(req); const f = await ownedFile(db, req.params.id, u);
    if (f.status !== 'ready' || !f.expires_at || new Date(f.expires_at).getTime() <= Date.now()) throw new HttpError(409, 'File chưa sẵn sàng hoặc đã hết hạn.');
    const filename = encodeURIComponent(f.name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16));
    reply.header('Content-Disposition', `attachment; filename="download"; filename*=UTF-8''${filename}`).header('Content-Type', 'application/octet-stream').header('Cache-Control', 'private, no-store').header('Accept-Ranges', 'bytes');
    await audit(db, u.id, 'download_requested', f.id);
    if (config.NGINX_DOWNLOADS === 'true') return reply.header('X-Accel-Redirect', `/_protected_files/${f.id}`).send();
    const fullSize = (await stat(filePath(config, f.id))).size;
    let start = 0, end = fullSize - 1;
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) return reply.code(416).header('Content-Range', `bytes */${fullSize}`).send();
      if (!match[1]) { const count = Number(match[2]); if (!count) return reply.code(416).header('Content-Range', `bytes */${fullSize}`).send(); start = Math.max(0, fullSize - count); }
      else { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), fullSize - 1) : end; }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= fullSize) return reply.code(416).header('Content-Range', `bytes */${fullSize}`).send();
      reply.code(206).header('Content-Range', `bytes ${start}-${end}/${fullSize}`);
    }
    reply.header('Content-Length', end - start + 1);
    return reply.send(createReadStream(filePath(config, f.id), { start, end }));
  });

  app.get('/api/admin/users', async req => {
    await admin(req);
    const rows = await db.query<User & { used: string }>(`SELECT u.id,u.employee_code,u.name,u.role,u.disabled,u.quota_bytes,COALESCE(sum(f.reserved_bytes),0) AS used
      FROM users u LEFT JOIN files f ON f.owner_id=u.id GROUP BY u.id ORDER BY u.created_at`);
    return { users: rows.rows.map(u => ({ ...summary(u), used: Number(u.used) })) };
  });
  app.post('/api/admin/users', async (req, reply) => {
    const a = await admin(req, true); const input = userSchema.parse(req.body);
    const hash = await hashPassword(input.password); const id = randomUUID();
    try { await db.transaction(async tx => { await tx.query(`INSERT INTO users(id,employee_code,name,password_hash,role,quota_bytes) VALUES($1,$2,$3,$4,'employee',$5)`, [id, input.employeeCode, input.name, hash, input.quota ?? config.USER_QUOTA_BYTES]); await audit(tx, a.id, 'user_created', undefined, input.employeeCode); }); }
    catch (e) { if ((e as { code?: string }).code === '23505') throw new HttpError(409, 'Mã nhân viên đã được sử dụng.'); throw e; }
    return reply.code(201).send({ id });
  });
  app.patch<{ Params: { id: string } }>('/api/admin/users/:id', async req => {
    const a = await admin(req, true); const input = userUpdate.parse(req.body);
    if (!validId(req.params.id)) throw new HttpError(404, 'Không tìm thấy tài khoản.');
    if (req.params.id === a.id && input.disabled) throw new HttpError(400, 'Không thể tự khóa tài khoản quản trị.');
    const hash = input.password ? await hashPassword(input.password) : null;
    try { await db.transaction(async tx => {
      const row = await tx.query(`UPDATE users SET disabled=COALESCE($2,disabled),password_hash=COALESCE($3,password_hash),quota_bytes=COALESCE($4,quota_bytes),employee_code=COALESCE($5,employee_code) WHERE id=$1 RETURNING id`, [req.params.id, input.disabled ?? null, hash, input.quota ?? null, input.employeeCode ?? null]);
      if (!row.rows.length) throw new HttpError(404, 'Không tìm thấy tài khoản.');
      if (hash || input.disabled) await tx.query('DELETE FROM sessions WHERE user_id=$1', [req.params.id]);
      await audit(tx, a.id, 'user_updated', undefined, req.params.id);
    }); } catch (e) { if ((e as { code?: string }).code === '23505') throw new HttpError(409, 'Mã nhân viên đã được sử dụng.'); throw e; }
    return { ok: true };
  });
  app.get('/api/admin/audit', async req => {
    await admin(req);
    const rows = await db.query(`SELECT a.id,a.action,a.file_id,a.detail,a.created_at,u.employee_code AS "employeeCode" FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 200`);
    return { events: rows.rows };
  });
  app.get('/api/admin/storage', async req => {
    await admin(req); const result = await db.query<{ used: string; waiting: string }>(`SELECT COALESCE(sum(reserved_bytes),0) AS used,count(*) FILTER(WHERE status IN ('queued','downloading','verifying')) AS waiting FROM files`);
    return { used: Number(result.rows[0].used), quota: config.GLOBAL_QUOTA_BYTES, waiting: Number(result.rows[0].waiting), maxFileBytes: config.MAX_FILE_BYTES };
  });

  // Scope the streaming body parser to tus: JSON API routes keep their small body limit.
  const tus = new TusServer({
    path: '/api/uploads', datastore: new FileStore({ directory: config.DATA_DIR }),
    maxSize: config.MAX_FILE_BYTES, relativeLocation: true, allowedOrigins: [],
    allowedHeaders: ['x-csrf-token'], disableTerminationForFinishedUploads: true,
    namingFunction: async (_req, metadata) => metadata!.fileId!,
    onUploadCreate: async (_req, upload) => {
      const id = upload.id;
      const row = await db.query<FileRow>(`UPDATE files SET status='uploading',updated_at=now() WHERE id=$1 AND status='pending' AND size_bytes=$2 RETURNING *`, [id, upload.size]);
      if (!row.rows.length) throw { status_code: 409, body: 'Phiên upload đã được tạo hoặc dung lượng không khớp.' };
      return {};
    },
    onUploadFinish: async (_req, upload) => {
      const row = await db.query(`UPDATE files SET status='verifying',received_bytes=size_bytes,updated_at=now() WHERE id=$1 AND status='uploading' RETURNING id`, [upload.id]);
      if (!row.rows.length) throw { status_code: 410, body: 'File đã bị hủy.' };
      return {};
    },
  });
  await app.register(async scope => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_req, _payload, done) => done(null));
    scope.all('/api/uploads', { bodyLimit: 32 * 1024 * 1024 }, handleTus);
    scope.all('/api/uploads/:id', { bodyLimit: 32 * 1024 * 1024 }, handleTus);
    async function handleTus(req: FastifyRequest, reply: import('fastify').FastifyReply) {
      if (req.method === 'OPTIONS') { await user(req); reply.hijack(); await tus.handle(req.raw, reply.raw); return; }
      if (!['POST', 'PATCH', 'HEAD'].includes(req.method)) throw new HttpError(405, 'Thao tác upload không được hỗ trợ.');
      const u = await user(req, req.method !== 'HEAD');
      const contentLength = Number(req.headers['content-length'] ?? 0);
      if (req.method === 'PATCH' && (!req.headers['content-length'] || contentLength > 32 * 1024 * 1024)) throw new HttpError(413, 'Mỗi phần upload tối đa 32 MB và cần Content-Length.');
      let id = (req.params as { id?: string }).id;
      if (req.method === 'POST') {
        const metadata = String(req.headers['upload-metadata'] ?? '').split(',');
        const item = metadata.find(m => m.trim().startsWith('fileId '));
        id = item ? Buffer.from(item.trim().slice(7), 'base64').toString() : undefined;
      }
      if (!id || !validId(id)) throw new HttpError(400, 'Phiên upload không hợp lệ.');
      const f = await ownedFile(db, id, u);
      // Admin can manage files but cannot write another employee's upload.
      if (f.owner_id !== u.id) throw new HttpError(404, 'Không tìm thấy phiên upload.');
      if ((req.method === 'POST' && f.status !== 'pending') || (req.method === 'PATCH' && f.status !== 'uploading') || (req.method === 'HEAD' && !['uploading','verifying','ready'].includes(f.status))) throw new HttpError(409, 'Phiên upload không còn hoạt động.');
      if (activeUploads.has(id)) throw new HttpError(409, 'Một phần của file đang được ghi. Hãy thử lại.');
      activeUploads.add(id);
      await db.query('UPDATE files SET updated_at=now() WHERE id=$1', [id]);
      try { reply.hijack(); await tus.handle(req.raw, reply.raw); }
      finally {
        activeUploads.delete(id);
        try {
          const bytes = (await stat(filePath(config, id))).size;
          await db.query(`UPDATE files SET received_bytes=$2,updated_at=now() WHERE id=$1 AND status='uploading'`, [id, bytes]);
        } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') app.log.error('Could not update upload progress.'); }
      }
    }
  });
  const webRoot = path.resolve('dist/web');
  if (existsSync(path.join(webRoot, 'index.html'))) {
    await app.register(staticFiles, { root: webRoot });
    app.setNotFoundHandler((req, reply) => req.url.startsWith('/api') ? reply.code(404).send({ message: 'Không tìm thấy API.' }) : reply.sendFile('index.html'));
  }
  await app.ready();
  if (options.worker !== false) worker.start();
  return { app, worker };
}
