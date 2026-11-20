export type VariantType = 'original' | 'thumbnail' | 'preview';

export type ImageStatus = 'pending' | 'processing' | 'ready' | 'failed';

export type DeletionState = 'active' | 'pending_deletion' | 'deleted';

export type GroupStatus = 'active' | 'archived';

export interface UserProfile {
  id: string;
  oidcIssuer: string;
  oidcSub: string;
  email?: string | null;
  displayName?: string | null;
}

export interface GroupModel {
  id: string;
  ownerId: string;
  name: string;
  description?: string | null;
  retentionHours: number;
  status: GroupStatus;
  nextSequenceNumber: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ImageModel {
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
  status: ImageStatus;
  deletionState: DeletionState;
  deletionRequestedAt?: Date | null;
  deletionDeadline?: Date | null;
  deletionRequestedBy?: string | null;
  createdAt: Date;
  updatedAt: Date;
  tags?: string[];
}

export interface ImageVariantModel {
  id: string;
  imageId: string;
  variantType: VariantType;
  storageKey: string;
  mediaType: string;
  width?: number | null;
  height?: number | null;
  byteSize: number;
  createdAt: Date;
}

export interface PresignedDownloadUrl {
  imageId: string;
  variant: VariantType;
  url: string;
  expiresAt: string; // ISO 8601
  expiresInSeconds: number; // 3600
  mediaType: string;
  byteSize?: number;
}

export interface EventOutboxModel {
  cursor: number;
  eventId: string;
  eventType: string;
  ownerId: string;
  groupId?: string | null;
  imageId?: string | null;
  payload: Record<string, unknown>;
  publishedAt?: Date | null;
  createdAt: Date;
}
