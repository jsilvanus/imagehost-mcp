import sharp from 'sharp';

export interface ProcessedVariant {
  variantType: 'thumbnail' | 'preview';
  buffer: Buffer;
  mediaType: string;
  width: number;
  height: number;
  byteSize: number;
}

export interface ProcessingResult {
  originalWidth: number;
  originalHeight: number;
  variants: ProcessedVariant[];
}

export class ImageProcessor {
  constructor(private maxPixels = 50_000_000) {}

  async processImage(buffer: Buffer): Promise<ProcessingResult> {
    const pipeline = sharp(buffer, {
      limitInputPixels: this.maxPixels,
      failOnError: true,
    });

    const metadata = await pipeline.metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error('Invalid image: missing dimensions');
    }

    // Auto-orient according to EXIF tag
    const orientedPipeline = pipeline.rotate();
    const orientedMeta = await orientedPipeline.metadata();

    const originalWidth = orientedMeta.width || metadata.width;
    const originalHeight = orientedMeta.height || metadata.height;

    // Generate Thumbnail: max 320px longest edge, WebP, stripped EXIF
    const thumbnailBuffer = await sharp(buffer)
      .rotate()
      .resize({
        width: 320,
        height: 320,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 80 })
      .toBuffer();

    const thumbnailMeta = await sharp(thumbnailBuffer).metadata();

    // Generate Preview: max 1280px longest edge, WebP, stripped EXIF
    const previewBuffer = await sharp(buffer)
      .rotate()
      .resize({
        width: 1280,
        height: 1280,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 85 })
      .toBuffer();

    const previewMeta = await sharp(previewBuffer).metadata();

    return {
      originalWidth,
      originalHeight,
      variants: [
        {
          variantType: 'thumbnail',
          buffer: thumbnailBuffer,
          mediaType: 'image/webp',
          width: thumbnailMeta.width || 320,
          height: thumbnailMeta.height || 320,
          byteSize: thumbnailBuffer.length,
        },
        {
          variantType: 'preview',
          buffer: previewBuffer,
          mediaType: 'image/webp',
          width: previewMeta.width || 1280,
          height: previewMeta.height || 1280,
          byteSize: previewBuffer.length,
        },
      ],
    };
  }
}
