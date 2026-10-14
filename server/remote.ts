import dns from 'node:dns/promises';
import net from 'node:net';
import type { LookupFunction } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, request } from 'undici';
import { HttpError } from './auth.js';
import type { Config } from './config.js';

export function isPublicIp(address: string): boolean {
  try {
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) parsed = (parsed as ipaddr.IPv6).toIPv4Address();
    // Excludes private, loopback, link-local, multicast, reserved and transition networks.
    return parsed.range() === 'unicast';
  } catch { return false; }
}
export function parseRemoteUrl(input: string) {
  let url: URL;
  try { url = new URL(input); } catch { throw new HttpError(400, 'Link không hợp lệ.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw new HttpError(400, 'Chỉ nhận link HTTP/HTTPS trên cổng 80 hoặc 443, không chứa thông tin đăng nhập.');
  url.hash = '';
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal') || (net.isIP(hostname) && !isPublicIp(hostname))) throw new HttpError(400, 'Không nhận link đến mạng nội bộ hoặc địa chỉ đặc biệt.');
  return url;
}
export function driveReference(url: URL): { id: string; resourceKey?: string } | null {
  if (url.hostname !== 'drive.google.com') return null;
  const id = /^\/file\/d\/([\w-]+)/.exec(url.pathname)?.[1] ?? url.searchParams.get('id');
  if (!id || !/^[\w-]{10,200}$/.test(id)) throw new HttpError(400, 'Chỉ hỗ trợ link của một file Google Drive, chưa hỗ trợ thư mục.');
  const resourceKey = url.searchParams.get('resourcekey') ?? undefined;
  if (resourceKey && !/^[\w-]{1,200}$/.test(resourceKey)) throw new HttpError(400, 'Resource key không hợp lệ.');
  return { id, resourceKey };
}
export type OpenRemote = typeof openRemote;
export function pinnedLookup(address: { address: string; family: number }): LookupFunction {
  return (_host, options, callback) => {
    if (options.all) {
      // Node's autoSelectFamily requests an array, despite LookupFunction's single-address callback type.
      (callback as unknown as (error: null, addresses: { address: string; family: number }[]) => void)(null, [address]);
    } else callback(null, address.address, address.family);
  };
}
export async function openRemote(input: string, headers: Record<string, string> = {}, signal?: AbortSignal) {
  let url = parseRemoteUrl(input);
  let currentHeaders = { ...headers, 'accept-encoding': 'identity' };
  for (let redirect = 0; redirect <= 5; redirect++) {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] : await dns.lookup(hostname, { all: true, verbatim: true });
    if (addresses.length === 0 || addresses.some(a => !isPublicIp(a.address))) throw new HttpError(400, 'Nguồn tải phân giải đến địa chỉ không được phép.');
    const selected = addresses.find(a => a.family === 4) ?? addresses[0];
    // Pin the verified address for the actual connection: no second DNS resolution.
    const agent = new Agent({ connect: { timeout: 15_000, lookup: pinnedLookup(selected) } });
    try {
      const response = await request(url, { dispatcher: agent, method: 'GET', headers: currentHeaders, headersTimeout: 30_000, bodyTimeout: 30_000, signal });
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.body.destroy(); await agent.close();
        const location = response.headers.location;
        if (typeof location !== 'string') throw new HttpError(400, 'Nguồn tải chuyển hướng không hợp lệ.');
        const next = parseRemoteUrl(new URL(location, url).href);
        if (next.origin !== url.origin) currentHeaders = { 'accept-encoding': 'identity' };
        url = next; continue;
      }
      if (response.statusCode !== 200) {
        response.body.destroy(); await agent.close();
        throw new HttpError(400, `Nguồn tải trả về HTTP ${response.statusCode}. Kiểm tra quyền chia sẻ và hạn mức tải.`);
      }
      const encoding = response.headers['content-encoding'];
      if (encoding && encoding !== 'identity') { response.body.destroy(); await agent.close(); throw new HttpError(400, 'Nguồn tải dùng kiểu nén truyền không được hỗ trợ.'); }
      return { body: response.body as AsyncIterable<Uint8Array> & { destroy?: () => void }, headers: response.headers, finalUrl: url.href,
        close: async () => { response.body.destroy(); await agent.close(); } };
    } catch (error) { await agent.destroy(); throw error; }
  }
  throw new HttpError(400, 'Nguồn tải chuyển hướng quá nhiều lần.');
}
export async function readLimitedJson(remote: Awaited<ReturnType<OpenRemote>>, limit = 1_000_000) {
  try {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of remote.body) { size += chunk.length; if (size > limit) throw new Error('Metadata too large'); chunks.push(Buffer.from(chunk)); }
    return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, any>;
  } finally { await remote.close(); }
}
export async function resolveSource(input: string, config: Config, open: OpenRemote = openRemote, signal?: AbortSignal) {
  const url = parseRemoteUrl(input); const drive = driveReference(url);
  if (!drive) {
    if (['docs.google.com', 'sheets.google.com', 'slides.google.com'].includes(url.hostname)) throw new HttpError(400, 'Chưa hỗ trợ xuất Google Docs, Sheets hoặc Slides.');
    return { url: url.href, name: null as string | null, md5: null as string | null, size: null as number | null, headers: {} as Record<string, string> };
  }
  if (!config.GOOGLE_DRIVE_API_KEY) throw new HttpError(503, 'Chưa cấu hình Google Drive API. Có thể tải file bằng máy ngoài rồi upload lên trạm.');
  const endpoint = new URL(`https://www.googleapis.com/drive/v3/files/${drive.id}`);
  // API key accesses publicly shared files only; no personal OAuth tokens are stored.
  endpoint.searchParams.set('key', config.GOOGLE_DRIVE_API_KEY);
  endpoint.searchParams.set('fields', 'name,size,mimeType,md5Checksum');
  const headers: Record<string, string> = drive.resourceKey ? { 'X-Goog-Drive-Resource-Keys': `${drive.id}/${drive.resourceKey}` } : {};
  const metadata = await readLimitedJson(await open(endpoint.href, headers, signal));
  if (String(metadata.mimeType).startsWith('application/vnd.google-apps.') || !metadata.size) throw new HttpError(400, 'Chỉ hỗ trợ file thông thường trên Google Drive, không hỗ trợ thư mục hoặc tài liệu Google.');
  const size = Number(metadata.size);
  if (!Number.isSafeInteger(size) || size < 1 || size > config.MAX_FILE_BYTES) throw new HttpError(413, 'File Google Drive có dung lượng không hợp lệ hoặc vượt giới hạn 2 GB.');
  endpoint.searchParams.delete('fields'); endpoint.searchParams.set('alt', 'media');
  return { url: endpoint.href, name: String(metadata.name), md5: metadata.md5Checksum ? String(metadata.md5Checksum) : null, size, headers };
}
