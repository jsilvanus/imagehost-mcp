import React, { useState } from 'react';
import { X, Folder, Check } from 'lucide-react';
import type { Group } from '../types';

interface GroupModalProps {
  initialGroup?: Group | null;
  onClose: () => void;
  onSave: (data: { name: string; description?: string; retentionHours: number }) => Promise<void>;
}

export const GroupModal: React.FC<GroupModalProps> = ({ initialGroup, onClose, onSave }) => {
  const [name, setName] = useState(initialGroup?.name || '');
  const [description, setDescription] = useState(initialGroup?.description || '');
  const [retentionHours, setRetentionHours] = useState(initialGroup?.retentionHours || 72);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Group name is required');
      return;
    }
    try {
      setLoading(true);
      await onSave({
        name: name.trim(),
        description: description.trim() || undefined,
        retentionHours,
      });
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to save group');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Folder size={18} color="var(--accent-blue)" />
            <h2 style={{ fontSize: '1rem', fontWeight: 700 }}>
              {initialGroup ? 'Edit Group Settings' : 'Create New Photo Group'}
            </h2>
          </div>
          <button className="btn-icon" onClick={onClose} aria-label="Close dialog">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="modal-body">
          {error && (
            <div
              style={{
                background: 'rgba(239, 68, 68, 0.15)',
                color: '#f87171',
                padding: '0.5rem',
                borderRadius: '6px',
                fontSize: '0.8rem',
              }}
            >
              {error}
            </div>
          )}

          <div>
            <label
              style={{
                display: 'block',
                fontSize: '0.82rem',
                fontWeight: 600,
                marginBottom: '0.3rem',
              }}
            >
              Group Name *
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Vacation 2026, Nature, Receipts..."
              style={{
                width: '100%',
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '8px',
                padding: '0.6rem 0.8rem',
                color: 'var(--text-primary)',
                fontSize: '0.9rem',
              }}
              autoFocus
            />
          </div>

          <div>
            <label
              style={{
                display: 'block',
                fontSize: '0.82rem',
                fontWeight: 600,
                marginBottom: '0.3rem',
              }}
            >
              Description
            </label>
            <textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description of this collection"
              style={{
                width: '100%',
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '8px',
                padding: '0.6rem 0.8rem',
                color: 'var(--text-primary)',
                fontSize: '0.85rem',
                resize: 'none',
              }}
            />
          </div>

          <div>
            <label
              style={{
                display: 'block',
                fontSize: '0.82rem',
                fontWeight: 600,
                marginBottom: '0.3rem',
              }}
            >
              Deletion Retention Period
            </label>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
              When an agent or user requests deletion, photos stay in &apos;Pending Deletion&apos;
              with a red X before being permanently purged.
            </p>
            <select
              value={retentionHours}
              onChange={(e) => setRetentionHours(Number(e.target.value))}
              style={{
                width: '100%',
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '8px',
                padding: '0.6rem 0.8rem',
                color: 'var(--text-primary)',
                fontSize: '0.85rem',
              }}
            >
              <option value={24}>24 Hours (1 Day)</option>
              <option value={72}>72 Hours (3 Days — Recommended)</option>
              <option value={168}>168 Hours (7 Days)</option>
              <option value={720}>720 Hours (30 Days)</option>
            </select>
          </div>

          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '0.5rem',
              marginTop: '0.5rem',
            }}
          >
            <button
              type="button"
              className="btn-icon"
              style={{
                width: 'auto',
                padding: '0.5rem 0.8rem',
                borderRadius: '8px',
                fontSize: '0.85rem',
              }}
              onClick={onClose}
            >
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={loading}>
              <Check size={16} />
              {initialGroup ? 'Save Changes' : 'Create Group'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
