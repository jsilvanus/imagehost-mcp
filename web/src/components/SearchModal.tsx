import React, { useState, useEffect } from 'react';
import { X, Search, Loader2 } from 'lucide-react';
import type { ImageItem } from '../types';
import { api } from '../api';

interface SearchModalProps {
  onClose: () => void;
  onSelectImage: (image: ImageItem) => void;
}

export const SearchModal: React.FC<SearchModalProps> = ({ onClose, onSelectImage }) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ImageItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    const timer = setTimeout(async () => {
      if (!query.trim()) {
        setResults([]);
        return;
      }
      try {
        setLoading(true);
        const items = await api.searchImages(query.trim());
        setResults(items);

        // Fetch thumbnails for results
        if (items.length > 0) {
          const batch = await api.getBatchDownloadUrls(
            items.map((i) => ({ imageId: i.id, variant: 'thumbnail' })),
          );
          const urls: Record<string, string> = {};
          for (const b of batch) {
            if (b.url) urls[b.imageId] = b.url;
          }
          setThumbnailUrls(urls);
        }
      } catch (err) {
        console.error('Search error:', err);
      } finally {
        setLoading(false);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [query]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-content"
        style={{ maxWidth: '580px', maxHeight: '85vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.6rem',
              flex: 1,
              marginRight: '0.5rem',
            }}
          >
            <Search size={18} color="var(--text-muted)" />
            <input
              type="text"
              placeholder="Search by description, filename, or tag..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{
                width: '100%',
                background: 'transparent',
                border: 'none',
                color: 'var(--text-primary)',
                fontSize: '0.95rem',
                outline: 'none',
              }}
              autoFocus
            />
          </div>
          <button className="btn-icon" onClick={onClose} aria-label="Close search">
            <X size={18} />
          </button>
        </div>

        <div className="modal-body" style={{ overflowY: 'auto', padding: '1rem' }}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
              <Loader2 size={24} className="animate-spin" style={{ margin: '0 auto 0.5rem' }} />
              Searching library...
            </div>
          ) : results.length > 0 ? (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: '4px',
              }}
            >
              {results.map((img) => (
                <div
                  key={img.id}
                  className="image-cell"
                  style={{ borderRadius: '6px' }}
                  onClick={() => {
                    onSelectImage(img);
                    onClose();
                  }}
                >
                  <div className="seq-badge">#{String(img.sequenceNumber).padStart(3, '0')}</div>
                  {thumbnailUrls[img.id] ? (
                    <img src={thumbnailUrls[img.id]} alt={img.originalFilename} />
                  ) : (
                    <div className="image-placeholder">
                      <span style={{ fontSize: '0.65rem' }}>{img.originalFilename}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : query ? (
            <div
              style={{
                textAlign: 'center',
                padding: '2rem',
                color: 'var(--text-muted)',
                fontSize: '0.9rem',
              }}
            >
              No images matched &quot;{query}&quot;
            </div>
          ) : (
            <div
              style={{
                textAlign: 'center',
                padding: '2rem',
                color: 'var(--text-muted)',
                fontSize: '0.85rem',
              }}
            >
              Type to search photos across all your groups.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
