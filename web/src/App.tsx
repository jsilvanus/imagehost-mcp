import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Header } from './components/Header';
import { ImageGrid } from './components/ImageGrid';
import { DetailModal } from './components/DetailModal';
import { CaptureBar } from './components/CaptureBar';
import { CameraModal } from './components/CameraModal';
import { GroupModal } from './components/GroupModal';
import { SearchModal } from './components/SearchModal';
import { UploadBanner, type UploadItem } from './components/UploadBanner';
import { api } from './api';
import type { User, Group, ImageItem } from './types';
import { Settings, FolderPlus } from 'lucide-react';

export const App: React.FC = () => {
  const [user, setUser] = useState<User | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [groupImages, setGroupImages] = useState<Record<string, ImageItem[]>>({});
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string>>({});

  // Modals state
  const [selectedImage, setSelectedImage] = useState<ImageItem | null>(null);
  const [isGroupModalOpen, setIsGroupModalOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<Group | null>(null);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isLiveCameraOpen, setIsLiveCameraOpen] = useState(false);

  // Upload queue
  const [uploadQueue, setUploadQueue] = useState<UploadItem[]>([]);
  const nativeCameraInputRef = useRef<HTMLInputElement>(null);

  // Initial load
  const loadLibrary = useCallback(async () => {
    try {
      const currentUser = await api.getMe();
      setUser(currentUser);

      let fetchedGroups = await api.listGroups();

      // If no groups exist and user is logged in, auto-create a default group
      if (fetchedGroups.length === 0 && currentUser) {
        const defaultGroup = await api.createGroup({
          name: 'General',
          description: 'Default photo collection',
          retentionHours: 72,
        });
        fetchedGroups = [defaultGroup];
      }

      setGroups(fetchedGroups);
      if (fetchedGroups.length > 0 && !activeGroupId) {
        setActiveGroupId(fetchedGroups[0].id);
      }

      // Fetch images for all active groups
      const imagesMap: Record<string, ImageItem[]> = {};
      const allImageIds: string[] = [];

      for (const grp of fetchedGroups) {
        const res = await api.listGroupImages(grp.id, true);
        imagesMap[grp.id] = res.items;
        for (const item of res.items) {
          allImageIds.push(item.id);
        }
      }
      setGroupImages(imagesMap);

      // Batch load thumbnails
      if (allImageIds.length > 0) {
        const batch = await api.getBatchDownloadUrls(
          allImageIds.map((id) => ({ imageId: id, variant: 'thumbnail' })),
        );
        setThumbnailUrls((prev) => {
          const updated = { ...prev };
          for (const item of batch) {
            if (item.url) updated[item.imageId] = item.url;
          }
          return updated;
        });
      }
    } catch (err) {
      console.error('Failed to load library:', err);
    }
  }, [activeGroupId]);

  useEffect(() => {
    loadLibrary();
  }, [loadLibrary]);

  // Upload processor
  const processUpload = async (item: UploadItem) => {
    try {
      // 1. Create upload session
      const session = await api.createUploadSession(item.groupId, {
        filename: item.name,
        mediaType: item.file.type || 'image/jpeg',
        byteSize: item.file.size,
      });

      // 2. Upload direct to S3
      await api.uploadDirectToS3(session.uploadUrl, item.file, (percent) => {
        setUploadQueue((prev) =>
          prev.map((q) => (q.id === item.id ? { ...q, progress: percent } : q)),
        );
      });

      // 3. Complete upload
      setUploadQueue((prev) =>
        prev.map((q) => (q.id === item.id ? { ...q, status: 'processing', progress: 100 } : q)),
      );
      await api.completeUpload(session.uploadId);

      setUploadQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, status: 'done' } : q)));

      // Refresh images
      await loadLibrary();

      // Dismiss completed item after 3 seconds
      setTimeout(() => {
        setUploadQueue((prev) => prev.filter((q) => q.id !== item.id));
      }, 3000);
    } catch (err: any) {
      setUploadQueue((prev) =>
        prev.map((q) => (q.id === item.id ? { ...q, status: 'error', error: err.message } : q)),
      );
    }
  };

  const handleFilesSelected = (files: File[]) => {
    if (!activeGroupId && groups.length > 0) {
      setActiveGroupId(groups[0].id);
    }
    const targetGroupId = activeGroupId || (groups.length > 0 ? groups[0].id : null);
    if (!targetGroupId) {
      alert('Please create a photo group first before uploading.');
      return;
    }

    const newItems: UploadItem[] = files.map((f) => ({
      id: 'upload-' + Math.random().toString(36).slice(2, 9),
      name: f.name,
      progress: 0,
      status: 'uploading',
      file: f,
      groupId: targetGroupId,
    }));

    setUploadQueue((prev) => [...prev, ...newItems]);
    for (const item of newItems) {
      processUpload(item);
    }
  };

  const handleLiveCameraCapture = (blob: Blob) => {
    const targetGroupId = activeGroupId || (groups.length > 0 ? groups[0].id : null);
    if (!targetGroupId) {
      alert('Please create a photo group first.');
      return;
    }
    const filename = `photo_${Date.now()}.jpg`;
    const item: UploadItem = {
      id: 'upload-' + Math.random().toString(36).slice(2, 9),
      name: filename,
      progress: 0,
      status: 'uploading',
      file: blob,
      groupId: targetGroupId,
    };
    setUploadQueue((prev) => [...prev, item]);
    processUpload(item);
  };

  const handleQuickRestore = async (image: ImageItem, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api.restoreImage(image.id);
      await loadLibrary();
    } catch (err: any) {
      alert(`Could not restore: ${err.message}`);
    }
  };

  return (
    <div className="app-container">
      {/* Hidden fallback input */}
      <input
        ref={nativeCameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            handleFilesSelected(Array.from(e.target.files));
          }
        }}
      />

      {/* Top Header */}
      <Header
        user={user}
        onNewGroup={() => {
          setEditingGroup(null);
          setIsGroupModalOpen(true);
        }}
        onOpenSearch={() => setIsSearchOpen(true)}
        onLogout={async () => {
          await api.logout();
          setUser(null);
          window.location.reload();
        }}
      />

      {/* Main Photo Gallery */}
      <main style={{ paddingBottom: '1rem' }}>
        {groups.length === 0 ? (
          <div
            style={{
              padding: '4rem 1.5rem',
              textAlign: 'center',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '1rem',
            }}
          >
            <h2 style={{ fontSize: '1.25rem', fontWeight: 700 }}>Welcome to ImageHost</h2>
            <p style={{ color: 'var(--text-secondary)', maxWidth: '340px', fontSize: '0.9rem' }}>
              Your private photo library and MCP server for AI agents. Create your first group to
              start organizing photos.
            </p>
            <button
              className="btn-primary"
              onClick={() => {
                setEditingGroup(null);
                setIsGroupModalOpen(true);
              }}
            >
              <FolderPlus size={18} />
              Create First Group
            </button>
          </div>
        ) : (
          groups.map((group) => {
            const images = groupImages[group.id] || [];

            return (
              <section key={group.id} className="group-section">
                <div className="group-header">
                  <div className="group-title-row">
                    <h2 className="group-name">{group.name}</h2>
                    <span className="group-badge">{images.length} photos</span>
                    <span className="retention-badge">{group.retentionHours}h retention</span>
                  </div>

                  <button
                    className="btn-icon"
                    style={{ width: '32px', height: '32px' }}
                    onClick={() => {
                      setEditingGroup(group);
                      setIsGroupModalOpen(true);
                    }}
                    title="Group settings & retention"
                  >
                    <Settings size={15} />
                  </button>
                </div>

                {group.description && (
                  <p
                    style={{
                      fontSize: '0.8rem',
                      color: 'var(--text-muted)',
                      padding: '0 1rem 0.5rem',
                    }}
                  >
                    {group.description}
                  </p>
                )}

                {/* Dense Grid with 4-per-row mobile layout */}
                <ImageGrid
                  images={images}
                  thumbnailUrls={thumbnailUrls}
                  onSelectImage={(img) => setSelectedImage(img)}
                  onRestoreImage={handleQuickRestore}
                />
              </section>
            );
          })
        )}
      </main>

      {/* Floating Upload Progress Banner */}
      <UploadBanner
        queue={uploadQueue}
        onRetry={processUpload}
        onDismiss={(id) => setUploadQueue((prev) => prev.filter((q) => q.id !== id))}
      />

      {/* Bottom Floating Mobile Capture Bar */}
      <CaptureBar
        groups={groups}
        activeGroupId={activeGroupId}
        onSelectGroup={(id) => setActiveGroupId(id)}
        onFilesSelected={handleFilesSelected}
        onOpenLiveCamera={() => setIsLiveCameraOpen(true)}
      />

      {/* Modals */}
      {selectedImage && (
        <DetailModal
          image={selectedImage}
          onClose={() => setSelectedImage(null)}
          onUpdate={(updated) => {
            setSelectedImage(updated);
            loadLibrary();
          }}
        />
      )}

      {isGroupModalOpen && (
        <GroupModal
          initialGroup={editingGroup}
          onClose={() => setIsGroupModalOpen(false)}
          onSave={async (data) => {
            if (editingGroup) {
              await api.updateGroup(editingGroup.id, data);
            } else {
              await api.createGroup(data);
            }
            await loadLibrary();
          }}
        />
      )}

      {isSearchOpen && (
        <SearchModal
          onClose={() => setIsSearchOpen(false)}
          onSelectImage={(img) => setSelectedImage(img)}
        />
      )}

      {isLiveCameraOpen && (
        <CameraModal
          onCapture={handleLiveCameraCapture}
          onClose={() => setIsLiveCameraOpen(false)}
          onFallbackToNativeInput={() => nativeCameraInputRef.current?.click()}
        />
      )}
    </div>
  );
};
