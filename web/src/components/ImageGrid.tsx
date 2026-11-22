import React from 'react';
import { X, RefreshCw, AlertCircle, Loader2 } from 'lucide-react';
import type { ImageItem } from '../types';
import { appPath } from '../api';

interface ImageGridProps {
  images: ImageItem[];
  thumbnailUrls: Record<string, string>;
  onSelectImage: (image: ImageItem) => void;
  onRestoreImage: (image: ImageItem, e: React.MouseEvent) => void;
}

export const ImageGrid: React.FC<ImageGridProps> = ({
  images,
  thumbnailUrls,
  onSelectImage,
  onRestoreImage,
}) => {
  const formatSeq = (num: number) => String(num).padStart(3, '0');

  if (images.length === 0) {
    return (
      <div
        style={{
          padding: '2.5rem 1rem',
          textAlign: 'center',
          color: 'var(--text-muted)',
          fontSize: '0.85rem',
          background: 'rgba(255, 255, 255, 0.02)',
          borderRadius: '8px',
          margin: '0.5rem 1rem',
        }}
      >
        No photos yet. Capture or import photos below.
      </div>
    );
  }

  return (
    <div className="dense-grid">
      {images.map((img) => {
        const isPendingDeletion = img.deletionState === 'pending_deletion';
        const thumbUrl = thumbnailUrls[img.id];

        return (
          <div
            key={img.id}
            className="image-cell"
            onClick={() => onSelectImage(img)}
            role="button"
            tabIndex={0}
            aria-label={`Photo ${formatSeq(img.sequenceNumber)}`}
          >
            {/* Sequence number overlay */}
            <div className="seq-badge">{formatSeq(img.sequenceNumber)}</div>

            {/* Thumbnail Image or Status */}
            {thumbUrl ? (
              <img src={appPath(thumbUrl)} alt={img.description || img.originalFilename} loading="lazy" />
            ) : img.status === 'processing' ? (
              <div className="image-placeholder">
                <Loader2 size={18} className="animate-spin" />
              </div>
            ) : img.status === 'failed' ? (
              <div className="image-placeholder" style={{ color: 'var(--danger-red)' }}>
                <AlertCircle size={20} />
              </div>
            ) : (
              <div className="image-placeholder">
                <span style={{ fontSize: '0.65rem' }}>{formatSeq(img.sequenceNumber)}</span>
              </div>
            )}

            {/* Pending Deletion Overlay (Red X + Restore) */}
            {isPendingDeletion && (
              <div className="pending-deletion-overlay">
                <X size={34} strokeWidth={2.8} className="deletion-cross" />
                <span className="deletion-pill">Pending Deletion</span>
                <button
                  className="quick-restore-btn"
                  onClick={(e) => onRestoreImage(img, e)}
                  title="Restore this image"
                >
                  <RefreshCw size={10} style={{ display: 'inline', marginRight: '2px' }} />
                  Restore
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
