import React, { useRef } from 'react';
import { Camera, Image as ImageIcon } from 'lucide-react';
import type { Group } from '../types';

interface CaptureBarProps {
  groups: Group[];
  activeGroupId: string | null;
  onSelectGroup: (groupId: string) => void;
  onFilesSelected: (files: File[]) => void;
  onOpenLiveCamera: () => void;
}

export const CaptureBar: React.FC<CaptureBarProps> = ({
  groups,
  activeGroupId,
  onSelectGroup,
  onFilesSelected,
  onOpenLiveCamera,
}) => {
  const nativeCameraInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);

  const handleNativeCameraChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onFilesSelected(Array.from(e.target.files));
      e.target.value = '';
    }
  };

  const handleGalleryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onFilesSelected(Array.from(e.target.files));
      e.target.value = '';
    }
  };

  return (
    <nav className="capture-bar">
      {/* Hidden file inputs */}
      {/* 1. Native environment camera capture */}
      <input
        ref={nativeCameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleNativeCameraChange}
        style={{ display: 'none' }}
      />
      {/* 2. Multi-image gallery picker */}
      <input
        ref={galleryInputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={handleGalleryChange}
        style={{ display: 'none' }}
      />

      {/* Left: Device Gallery Import */}
      <button
        className="btn-icon"
        style={{ width: '44px', height: '44px', borderRadius: '12px' }}
        onClick={() => galleryInputRef.current?.click()}
        title="Import photos from device library"
        aria-label="Import from gallery"
      >
        <ImageIcon size={22} />
      </button>

      {/* Center: Primary Shutter Camera Capture */}
      <button
        className="shutter-btn"
        onClick={() => {
          // If browser supports getUserMedia, open live viewfinder modal; otherwise native capture input
          if (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') {
            onOpenLiveCamera();
          } else {
            nativeCameraInputRef.current?.click();
          }
        }}
        title="Take a photo"
        aria-label="Take photo"
      >
        <Camera size={26} strokeWidth={2.4} />
      </button>

      {/* Right: Group selector badge or direct camera toggle */}
      <div style={{ position: 'relative' }}>
        <select
          value={activeGroupId || ''}
          onChange={(e) => onSelectGroup(e.target.value)}
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-subtle)',
            color: 'var(--text-secondary)',
            borderRadius: '12px',
            height: '44px',
            padding: '0 0.6rem',
            fontSize: '0.8rem',
            maxWidth: '120px',
            outline: 'none',
            cursor: 'pointer',
          }}
          title="Select group to upload to"
        >
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </div>
    </nav>
  );
};
