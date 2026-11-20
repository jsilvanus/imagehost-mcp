import React, { useState, useEffect } from 'react';
import { X, Trash2, RefreshCw, Download, Tag as TagIcon, AlertTriangle } from 'lucide-react';
import type { ImageItem } from '../types';
import { api } from '../api';

interface DetailModalProps {
  image: ImageItem;
  onClose: () => void;
  onUpdate: (updated: ImageItem) => void;
}

export const DetailModal: React.FC<DetailModalProps> = ({ image, onClose, onUpdate }) => {
  const [current, setCurrent] = useState<ImageItem>(image);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [originalUrl, setOriginalUrl] = useState<string | null>(null);
  const [description, setDescription] = useState(image.description || '');
  const [isEditingDesc, setIsEditingDesc] = useState(false);
  const [newTag, setNewTag] = useState('');
  const [loading, setLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const formatSeq = (num: number) => String(num).padStart(3, '0');
  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  };

  useEffect(() => {
    let active = true;
    // Fetch preview URL (1280px)
    api
      .getDownloadUrl(image.id, 'preview')
      .then((res) => {
        if (active) setPreviewUrl(res.url);
      })
      .catch(() => {});

    // Fetch original URL for download
    api
      .getDownloadUrl(image.id, 'original')
      .then((res) => {
        if (active) setOriginalUrl(res.url);
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, [image.id]);

  const handleSaveDescription = async () => {
    try {
      setLoading(true);
      const updated = await api.updateDescription(current.id, description);
      setCurrent(updated);
      onUpdate(updated);
      setIsEditingDesc(false);
    } catch (err: any) {
      setActionError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleAddTag = async (e: React.FormEvent) => {
    e.preventDefault();
    const tag = newTag.trim().toLowerCase();
    if (!tag) return;
    try {
      setLoading(true);
      const updated = await api.addTags(current.id, [tag]);
      setCurrent(updated);
      onUpdate(updated);
      setNewTag('');
    } catch (err: any) {
      setActionError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRemoveTag = async (tagToRemove: string) => {
    try {
      setLoading(true);
      const updated = await api.removeTags(current.id, [tagToRemove]);
      setCurrent(updated);
      onUpdate(updated);
    } catch (err: any) {
      setActionError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (
      !confirm(
        'Move this photo to Pending Deletion? It can be restored before the retention period expires.',
      )
    )
      return;
    try {
      setLoading(true);
      const updated = await api.requestDeletion(current.id);
      setCurrent(updated);
      onUpdate(updated);
    } catch (err: any) {
      setActionError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRestore = async () => {
    try {
      setLoading(true);
      const updated = await api.restoreImage(current.id);
      setCurrent(updated);
      onUpdate(updated);
    } catch (err: any) {
      setActionError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const isPendingDeletion = current.deletionState === 'pending_deletion';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-content"
        style={{ maxWidth: '640px', maxHeight: '90vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <span
              style={{
                fontFamily: 'JetBrains Mono',
                fontWeight: 700,
                fontSize: '1rem',
                color: 'var(--accent-blue)',
              }}
            >
              #{formatSeq(current.sequenceNumber)}
            </span>
            <span
              style={{
                fontSize: '0.9rem',
                fontWeight: 600,
                maxWidth: '220px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={current.originalFilename}
            >
              {current.originalFilename}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            {originalUrl && (
              <a
                href={originalUrl}
                download={current.originalFilename}
                target="_blank"
                rel="noreferrer"
                className="btn-icon"
                title="Download original resolution"
              >
                <Download size={16} />
              </a>
            )}
            <button className="btn-icon" onClick={onClose} aria-label="Close modal">
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Scrollable Body */}
        <div className="modal-body" style={{ overflowY: 'auto' }}>
          {/* Pending Deletion Alert */}
          {isPendingDeletion && (
            <div
              style={{
                background: 'rgba(239, 68, 68, 0.15)',
                border: '1px solid var(--danger-red)',
                borderRadius: '8px',
                padding: '0.75rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '0.6rem',
              }}
            >
              <div
                style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#fca5a5' }}
              >
                <AlertTriangle size={18} />
                <div style={{ fontSize: '0.8rem' }}>
                  <strong>Pending Deletion</strong>
                  {current.deletionDeadline && (
                    <div style={{ fontSize: '0.72rem', color: '#f87171' }}>
                      Purges after {new Date(current.deletionDeadline).toLocaleDateString()}
                    </div>
                  )}
                </div>
              </div>
              <button
                className="btn-primary"
                style={{
                  background: 'var(--danger-red)',
                  padding: '0.4rem 0.8rem',
                  fontSize: '0.8rem',
                }}
                onClick={handleRestore}
                disabled={loading}
              >
                <RefreshCw size={14} /> Restore
              </button>
            </div>
          )}

          {actionError && (
            <div
              style={{
                background: 'rgba(239, 68, 68, 0.15)',
                color: '#f87171',
                padding: '0.5rem 0.75rem',
                borderRadius: '6px',
                fontSize: '0.8rem',
              }}
            >
              {actionError}
            </div>
          )}

          {/* Large Preview Image */}
          <div
            style={{
              position: 'relative',
              width: '100%',
              aspectRatio:
                current.width && current.height ? `${current.width}/${current.height}` : '4/3',
              maxHeight: '440px',
              background: '#070a10',
              borderRadius: '8px',
              overflow: 'hidden',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {previewUrl ? (
              <img
                src={previewUrl}
                alt={current.description || current.originalFilename}
                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
              />
            ) : (
              <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                Loading preview...
              </span>
            )}

            {isPendingDeletion && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  background: 'rgba(220, 38, 38, 0.35)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  pointerEvents: 'none',
                }}
              >
                <X
                  size={72}
                  strokeWidth={2.5}
                  style={{ color: '#ffffff', filter: 'drop-shadow(0 2px 8px rgba(0,0,0,0.8))' }}
                />
              </div>
            )}
          </div>

          {/* Metadata Specs Strip */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: '0.5rem',
              background: 'var(--bg-secondary)',
              padding: '0.6rem 0.8rem',
              borderRadius: '8px',
              fontSize: '0.78rem',
            }}
          >
            <div>
              <span style={{ color: 'var(--text-muted)', display: 'block' }}>Resolution</span>
              <strong>
                {current.width && current.height
                  ? `${current.width} × ${current.height}`
                  : 'Original'}
              </strong>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)', display: 'block' }}>Size</span>
              <strong>{formatBytes(current.byteSize)}</strong>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)', display: 'block' }}>Date</span>
              <strong>{new Date(current.createdAt).toLocaleDateString()}</strong>
            </div>
          </div>

          {/* Description Section */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <label
                style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-secondary)' }}
              >
                Description
              </label>
              {!isEditingDesc ? (
                <button
                  style={{
                    background: 'none',
                    border: 0,
                    color: 'var(--accent-blue)',
                    fontSize: '0.75rem',
                    cursor: 'pointer',
                  }}
                  onClick={() => setIsEditingDesc(true)}
                >
                  Edit
                </button>
              ) : (
                <div style={{ display: 'flex', gap: '0.4rem' }}>
                  <button
                    style={{
                      background: 'none',
                      border: 0,
                      color: 'var(--success-green)',
                      fontSize: '0.75rem',
                      cursor: 'pointer',
                    }}
                    onClick={handleSaveDescription}
                    disabled={loading}
                  >
                    Save
                  </button>
                  <button
                    style={{
                      background: 'none',
                      border: 0,
                      color: 'var(--text-muted)',
                      fontSize: '0.75rem',
                      cursor: 'pointer',
                    }}
                    onClick={() => {
                      setDescription(current.description || '');
                      setIsEditingDesc(false);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>

            {isEditingDesc ? (
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Add a photo description for AI agents..."
                rows={2}
                style={{
                  width: '100%',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-focus)',
                  borderRadius: '6px',
                  color: 'var(--text-primary)',
                  padding: '0.5rem',
                  fontSize: '0.85rem',
                  resize: 'none',
                }}
                autoFocus
              />
            ) : (
              <p
                style={{
                  fontSize: '0.85rem',
                  color: current.description ? 'var(--text-primary)' : 'var(--text-muted)',
                }}
              >
                {current.description || 'No description provided.'}
              </p>
            )}
          </div>

          {/* Tags Section */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            <label style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
              Tags
            </label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', alignItems: 'center' }}>
              {current.tags && current.tags.length > 0 ? (
                current.tags.map((t) => (
                  <span key={t} className="tag-pill">
                    <TagIcon size={12} />
                    {t}
                    <button
                      className="tag-remove-btn"
                      onClick={() => handleRemoveTag(t)}
                      title={`Remove tag ${t}`}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))
              ) : (
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>No tags yet</span>
              )}

              {/* Add tag form */}
              <form onSubmit={handleAddTag} style={{ display: 'inline-flex', gap: '0.2rem' }}>
                <input
                  type="text"
                  placeholder="+ tag"
                  value={newTag}
                  onChange={(e) => setNewTag(e.target.value)}
                  style={{
                    background: 'var(--bg-secondary)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: '6px',
                    color: 'var(--text-primary)',
                    padding: '2px 7px',
                    fontSize: '0.78rem',
                    width: '70px',
                  }}
                />
              </form>
            </div>
          </div>

          {/* Delete Action Button */}
          {!isPendingDeletion && (
            <div style={{ marginTop: '0.5rem', display: 'flex', justifyContent: 'flex-end' }}>
              <button
                style={{
                  background: 'none',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  color: 'var(--danger-red)',
                  borderRadius: '6px',
                  padding: '0.4rem 0.8rem',
                  fontSize: '0.8rem',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  cursor: 'pointer',
                }}
                onClick={handleDelete}
                disabled={loading}
              >
                <Trash2 size={14} /> Soft Delete Photo
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
