import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { ImageProcessor } from '../src/services/image-processor.js';
import { SessionService } from '../src/auth/session.js';

describe('ImageProcessor', () => {
  it('processes image and generates thumbnail (320px) and preview (1280px) in webp', async () => {
    // Generate a simple test JPEG image with Sharp
    const testBuffer = await sharp({
      create: {
        width: 1600,
        height: 1200,
        channels: 3,
        background: { r: 255, g: 100, b: 50 },
      },
    })
      .jpeg()
      .toBuffer();

    const processor = new ImageProcessor();
    const result = await processor.processImage(testBuffer);

    expect(result.originalWidth).toBe(1600);
    expect(result.originalHeight).toBe(1200);
    expect(result.variants).toHaveLength(2);

    const thumbnail = result.variants.find((v) => v.variantType === 'thumbnail')!;
    expect(thumbnail).toBeDefined();
    expect(thumbnail.mediaType).toBe('image/webp');
    expect(thumbnail.width).toBeLessThanOrEqual(320);
    expect(thumbnail.height).toBeLessThanOrEqual(320);

    const preview = result.variants.find((v) => v.variantType === 'preview')!;
    expect(preview).toBeDefined();
    expect(preview.mediaType).toBe('image/webp');
    expect(preview.width).toBeLessThanOrEqual(1280);
    expect(preview.height).toBeLessThanOrEqual(1280);
  });
});

describe('SessionService', () => {
  it('signs and verifies session tokens correctly', async () => {
    const session = new SessionService('super-secret-key-that-is-long-enough-32-chars');
    const token = await session.signSession({
      userId: 'test-user-id',
      oidcIssuer: 'https://issuer.example.com',
      oidcSub: 'sub-123',
      email: 'test@example.com',
    });

    expect(typeof token).toBe('string');

    const verified = await session.verifySession(token);
    expect(verified).not.toBeNull();
    expect(verified?.userId).toBe('test-user-id');
    expect(verified?.oidcSub).toBe('sub-123');
    expect(verified?.email).toBe('test@example.com');
  });

  it('rejects tampered tokens', async () => {
    const session = new SessionService('super-secret-key-that-is-long-enough-32-chars');
    const verified = await session.verifySession('invalid.token.here');
    expect(verified).toBeNull();
  });

  it('signs and verifies upload tokens with uploadId scoping', async () => {
    const session = new SessionService('super-secret-key-that-is-long-enough-32-chars');
    const token = await session.signUploadToken('user-1', 'upload-abc');
    expect(typeof token).toBe('string');

    const verified = await session.verifyUploadToken(token, 'upload-abc');
    expect(verified).toEqual({ userId: 'user-1' });

    // Wrong upload ID
    const wrongUpload = await session.verifyUploadToken(token, 'upload-wrong');
    expect(wrongUpload).toBeNull();

    // Tampered token
    const tampered = await session.verifyUploadToken(token + 'tamper', 'upload-abc');
    expect(tampered).toBeNull();
  });

  it('signs and verifies download tokens with variant scoping', async () => {
    const session = new SessionService('super-secret-key-that-is-long-enough-32-chars');
    const token = await session.signDownloadToken('user-1', 'image-xyz', 'thumbnail');
    expect(typeof token).toBe('string');

    const verified = await session.verifyDownloadToken(token, 'image-xyz', 'thumbnail');
    expect(verified).toEqual({ userId: 'user-1' });

    // Wrong variant
    const wrongVariant = await session.verifyDownloadToken(token, 'image-xyz', 'original');
    expect(wrongVariant).toBeNull();

    // Wrong image ID
    const wrongImage = await session.verifyDownloadToken(token, 'image-wrong', 'thumbnail');
    expect(wrongImage).toBeNull();

    // Tampered
    const tampered = await session.verifyDownloadToken(token + 'x', 'image-xyz', 'thumbnail');
    expect(tampered).toBeNull();
  });
});
