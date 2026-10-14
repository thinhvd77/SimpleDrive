import { useEffect, useRef } from 'react';
import Uppy from '@uppy/core';
import Dashboard from '@uppy/dashboard';
import Tus from '@uppy/tus';
import Vietnamese from '@uppy/locales/lib/vi_VN';
import '@uppy/core/css/style.min.css';
import '@uppy/dashboard/css/style.min.css';
import { api, type DriveFile, type Session } from './api';

export function Uploader({ session, onComplete, onError }: { session: Session; onComplete: () => void; onError: (message: string) => void }) {
  const target = useRef<HTMLDivElement>(null);
  const callback = useRef({ onComplete, onError }); callback.current = { onComplete, onError };
  useEffect(() => {
    if (!target.current) return;
    const key = (file: { name?: string; size?: number | null; data: unknown }) => `simpledrive:${session.user.id}:${file.name}:${file.size}:${file.data instanceof File ? file.data.lastModified : ''}`;
    const uppy = new Uppy({ id: `simpledrive-${session.user.id}`, autoProceed: false,
      restrictions: { maxFileSize: session.limits.maxFileBytes, minFileSize: 1, maxNumberOfFiles: 5 },
      locale: Vietnamese,
    }).use(Dashboard, { target: target.current, inline: true, height: 280, proudlyDisplayPoweredByUppy: false,
      hideProgressDetails: false, note: 'Tối đa 2 GB/file · Có thể tiếp tục khi mất mạng',
      locale: { strings: {
        dropPasteFiles: 'Kéo thả file vào đây hoặc %{browseFiles}', browseFiles: 'chọn từ máy tính',
        addMore: 'Thêm file', cancel: 'Hủy', done: 'Xong', removeFile: 'Bỏ file',
        uploadComplete: 'Upload hoàn tất', uploadPaused: 'Đã tạm dừng', resumeUpload: 'Tiếp tục upload', pauseUpload: 'Tạm dừng upload',
        retryUpload: 'Thử lại', uploading: 'Đang upload', complete: 'Hoàn tất',
        uploadXFiles: { 0: 'Upload %{smart_count} file', 1: 'Upload %{smart_count} file' },
        uploadXNewFiles: { 0: 'Upload %{smart_count} file mới', 1: 'Upload %{smart_count} file mới' },
      } },
    }).use(Tus, { endpoint: '/api/uploads', chunkSize: 16 * 1024 * 1024, retryDelays: [0, 1000, 3000, 5000, 10_000],
      headers: { 'X-CSRF-Token': session.csrf }, allowedMetaFields: ['fileId'],
      fingerprint: async (file, options) => `${session.user.id}:${file instanceof File ? file.name : ''}:${file instanceof Blob ? file.size : ''}:${file instanceof File ? file.lastModified : ''}:${options.metadata?.fileId}`,
    });
    uppy.addPreProcessor(async ids => {
      for (const id of ids) {
        const file = uppy.getFile(id); if (!file || file.meta.fileId) continue;
        let previous: string | null = null;
        try { previous = localStorage.getItem(key(file)); } catch { /* upload works without persistent browser storage */ }
        if (previous) {
          try {
            const existing = await api<{ file: DriveFile }>(`/files/${previous}`);
            if (['pending', 'uploading'].includes(existing.file.status)) { uppy.setFileMeta(id, { fileId: previous }); continue; }
          } catch { /* expired reservation: create a fresh one */ }
        }
        const reserved = await api<{ file: DriveFile }>('/files/uploads', { method: 'POST', body: JSON.stringify({ name: file.name, size: file.size }) }, session.csrf);
        uppy.setFileMeta(id, { fileId: reserved.file.id });
        try { localStorage.setItem(key(file), reserved.file.id); } catch { /* optional persistence */ }
      }
    });
    uppy.on('upload-success', file => {
      if (file) { try { localStorage.removeItem(key(file)); } catch { /* optional persistence */ } }
      callback.current.onComplete();
    });
    uppy.on('error', error => callback.current.onError(error.message));
    uppy.on('upload-error', (_file, error) => callback.current.onError(error.message));
    return () => uppy.destroy();
  }, [session.user.id, session.csrf, session.limits.maxFileBytes]);
  return <div ref={target} className="uploader"/>;
}
