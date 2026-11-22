export interface OpenAiFileRef {
  id?: string;
  name?: string;
  mime_type?: string;
  download_link?: string;
  url?: string;
  download_url?: string;
}

export interface ChatGptImportRequest {
  openaiFileIdRefs?: Array<OpenAiFileRef | string>;
  files?: Array<OpenAiFileRef | string>;
  groupId?: string;
  groupName?: string;
  description?: string;
  tags?: string[];
}

export interface ImportedImageResult {
  image_id: string;
  filename: string;
  mime_type: string;
  url: string;
  sequence_number?: number;
  width?: number;
  height?: number;
  byte_size?: number;
  status: 'success';
}

export interface ImportedImageError {
  id?: string;
  filename?: string;
  error: string;
}

export interface ChatGptImportResponse {
  success: boolean;
  images: ImportedImageResult[];
  errors?: ImportedImageError[];
}
