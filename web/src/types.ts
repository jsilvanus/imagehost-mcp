export interface User {
  userId: string;
  oidcIssuer: string;
  oidcSub: string;
  email?: string;
  displayName?: string;
}

export interface Group {
  id: string;
  ownerId: string;
  name: string;
  description?: string | null;
  retentionHours: number;
  status: 'active' | 'archived';
  nextSequenceNumber: number;
  createdAt: string;
  updatedAt: string;
}

export interface ImageItem {
  id: string;
  groupId: string;
  ownerId: string;
  sequenceNumber: number;
  originalFilename: string;
  mediaType: string;
  byteSize: number;
  width?: number | null;
  height?: number | null;
  description?: string | null;
  status: 'pending' | 'processing' | 'ready' | 'failed';
  deletionState: 'active' | 'pending_deletion' | 'deleted';
  deletionRequestedAt?: string | null;
  deletionDeadline?: string | null;
  deletionRequestedBy?: string | null;
  createdAt: string;
  updatedAt: string;
  tags?: string[];
  thumbnailUrl?: string;
  previewUrl?: string;
}

export interface PresignedUrl {
  imageId: string;
  variant: 'thumbnail' | 'preview' | 'original';
  url: string;
  expiresAt: string;
  expiresInSeconds: number;
}

export interface UploadSession {
  uploadId: string;
  uploadUrl: string;
  sequenceNumber: number;
  formattedSequence: string;
  expiresInSeconds: number;
}
