import React from 'react';
import { UploadCloud, CheckCircle2, AlertCircle, RefreshCw } from 'lucide-react';

export interface UploadItem {
  id: string;
  name: string;
  progress: number;
  status: 'uploading' | 'processing' | 'done' | 'error';
  error?: string;
  file: File | Blob;
  groupId: string;
}

interface UploadBannerProps {
  queue: UploadItem[];
  onRetry: (item: UploadItem) => void;
  onDismiss?: (id: string) => void;
}

export const UploadBanner: React.FC<UploadBannerProps> = ({ queue, onRetry }) => {
  if (queue.length === 0) return null;

  const active = queue.find((q) => q.status === 'uploading' || q.status === 'processing');
  const errorItem = queue.find((q) => q.status === 'error');
  const total = queue.length;
  const completed = queue.filter((q) => q.status === 'done').length;

  return (
    <div className="upload-progress-banner">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: '0.82rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontWeight: 600 }}>
          {errorItem ? (
            <AlertCircle size={16} color="var(--danger-red)" />
          ) : active ? (
            <UploadCloud size={16} color="var(--accent-blue)" />
          ) : (
            <CheckCircle2 size={16} color="var(--success-green)" />
          )}
          <span>
            {errorItem
              ? `Upload error: ${errorItem.name}`
              : active
                ? `Uploading ${active.name} (${completed + 1}/${total})`
                : `All ${total} photos uploaded successfully!`}
          </span>
        </div>

        {errorItem && (
          <button
            className="btn-icon"
            style={{ width: '28px', height: '28px' }}
            onClick={() => onRetry(errorItem)}
            title="Retry upload"
          >
            <RefreshCw size={14} />
          </button>
        )}
      </div>

      {active && (
        <div className="progress-bar-bg">
          <div className="progress-bar-fill" style={{ width: `${active.progress}%` }} />
        </div>
      )}

      {errorItem && (
        <div style={{ fontSize: '0.75rem', color: '#f87171' }}>
          {errorItem.error || 'Upload failed. Please check your network and retry.'}
        </div>
      )}
    </div>
  );
};
