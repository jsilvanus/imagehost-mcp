import type { User, Group, ImageItem, PresignedUrl, UploadSession } from './types';

declare global {
  interface Window {
    __APP_CONFIG__?: {
      brandName?: string;
    };
    __BRAND_NAME__?: string;
  }
}

/**
 * Return the configured application brand name (e.g. "Kuvarasto" or "ImageHost").
 * Checked against runtime server injection (window.__BRAND_NAME__), then Vite env, then default.
 */
export function getBrandName(): string {
  if (typeof window !== 'undefined') {
    if (window.__BRAND_NAME__) return window.__BRAND_NAME__;
    if (window.__APP_CONFIG__?.brandName) return window.__APP_CONFIG__.brandName;
  }
  return ((import.meta as any).env?.VITE_BRAND_NAME as string | undefined) || 'ImageHost';
}

/**
 * Build an application-local URL that respects the runtime deployment prefix
 * injected into the document's <base> element (allowing deployment at / or under DOMAIN_PATH).
 */
export function appPath(path: string): string {
  if (typeof document === 'undefined') return path;
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  const href = document.querySelector('base[data-app-base]')?.getAttribute('href') ?? '/';
  const pathname = new URL(href, window.location.origin).pathname;
  const basePath = pathname.endsWith('/') ? pathname : `${pathname}/`;
  const relativePath = path.startsWith('/') ? path.slice(1) : path;
  return `${basePath}${relativePath}`;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const url = appPath(path);
  const headers: Record<string, string> = {};
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, {
    ...options,
    credentials: 'include',
    headers: {
      ...headers,
      ...options.headers,
    },
  });

  if (!res.ok) {
    let message = `Request failed: ${res.status}`;
    try {
      const err = await res.json();
      message = err.message || err.error?.message || err.error || message;
    } catch {
      // ignore non-json error
    }
    throw new Error(message);
  }

  return res.json() as Promise<T>;
}

export const api = {
  // Config
  async getConfig(): Promise<{ brandName: string }> {
    try {
      return await request<{ brandName: string }>('/v1/config');
    } catch {
      return { brandName: getBrandName() };
    }
  },

  // Auth
  async getMe(): Promise<User | null> {
    try {
      return await request<User>('/v1/auth/me');
    } catch {
      return null;
    }
  },

  async logout(): Promise<void> {
    await request('/v1/auth/logout', { method: 'POST', body: '{}' });
  },

  // Groups
  async listGroups(): Promise<Group[]> {
    const res = await request<{ items: Group[] }>('/v1/groups');
    return res.items;
  },

  async createGroup(data: {
    name: string;
    description?: string;
    retentionHours?: number;
  }): Promise<Group> {
    return await request<Group>('/v1/groups', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async updateGroup(
    groupId: string,
    data: { name?: string; description?: string; retentionHours?: number },
  ): Promise<Group> {
    return await request<Group>(`/v1/groups/${groupId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },

  async listGroupImages(
    groupId: string,
    includePendingDeletion = true,
  ): Promise<{ items: ImageItem[]; nextCursor: number | null }> {
    return await request<{ items: ImageItem[]; nextCursor: number | null }>(
      `/v1/groups/${groupId}/images?limit=100&includePendingDeletion=${includePendingDeletion}`,
    );
  },

  // Search
  async searchImages(query?: string, tags?: string[]): Promise<ImageItem[]> {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (tags && tags.length > 0) {
      for (const t of tags) params.append('tags', t);
    }
    params.set('includePendingDeletion', 'true');
    const res = await request<{ items: ImageItem[] }>(`/v1/images/search?${params.toString()}`);
    return res.items;
  },

  // Upload Lifecycle
  async createUploadSession(
    groupId: string,
    data: {
      filename: string;
      mediaType: string;
      byteSize: number;
      description?: string;
      tags?: string[];
    },
  ): Promise<UploadSession> {
    return await request<UploadSession>(`/v1/groups/${groupId}/uploads`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async uploadDirectToS3(
    uploadUrl: string,
    file: File | Blob,
    onProgress?: (percent: number) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const targetUrl = appPath(uploadUrl);
      xhr.open('PUT', targetUrl, true);
      xhr.withCredentials = true;
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');

      if (onProgress && xhr.upload) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            onProgress(Math.round((e.loaded / e.total) * 100));
          }
        };
      }

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(new Error(`Upload failed with status ${xhr.status}`));
        }
      };

      xhr.onerror = () => reject(new Error('Network error during upload'));
      xhr.ontimeout = () => reject(new Error('Upload timed out'));
      xhr.send(file);
    });
  },

  async completeUpload(uploadId: string): Promise<ImageItem> {
    return await request<ImageItem>(`/v1/uploads/${uploadId}/complete`, {
      method: 'POST',
      body: '{}',
    });
  },

  // Image actions
  async getImage(imageId: string): Promise<ImageItem> {
    return await request<ImageItem>(`/v1/images/${imageId}`);
  },

  async getDownloadUrl(
    imageId: string,
    variant: 'thumbnail' | 'preview' | 'original' = 'preview',
  ): Promise<PresignedUrl> {
    return await request<PresignedUrl>(`/v1/images/${imageId}/download-url?variant=${variant}`);
  },

  async getBatchDownloadUrls(
    items: Array<{ imageId: string; variant?: 'thumbnail' | 'preview' | 'original' }>,
  ): Promise<Array<{ imageId: string; url?: string; error?: string }>> {
    const res = await request<{
      results: Array<{ imageId: string; url?: string; error?: string }>;
    }>('/v1/images/batch-download-urls', {
      method: 'POST',
      body: JSON.stringify({ items }),
    });
    return res.results;
  },

  async updateDescription(imageId: string, description: string): Promise<ImageItem> {
    return await request<ImageItem>(`/v1/images/${imageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ description }),
    });
  },

  async addTags(imageId: string, tags: string[]): Promise<ImageItem> {
    return await request<ImageItem>(`/v1/images/${imageId}/tags`, {
      method: 'POST',
      body: JSON.stringify({ tags }),
    });
  },

  async removeTags(imageId: string, tags: string[]): Promise<ImageItem> {
    return await request<ImageItem>(`/v1/images/${imageId}/tags`, {
      method: 'DELETE',
      body: JSON.stringify({ tags }),
    });
  },

  async requestDeletion(imageId: string): Promise<ImageItem> {
    return await request<ImageItem>(`/v1/images/${imageId}/deletion`, {
      method: 'POST',
      body: '{}',
    });
  },

  async restoreImage(imageId: string): Promise<ImageItem> {
    return await request<ImageItem>(`/v1/images/${imageId}/restore`, {
      method: 'POST',
      body: '{}',
    });
  },
};
