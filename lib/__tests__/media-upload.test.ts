import { detectedImageMime } from '@/lib/media-upload';

describe('media upload validation', () => {
  it('recognizes only supported image signatures', () => {
    expect(detectedImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0x00]))).toBe(
      'image/jpeg'
    );
    expect(
      detectedImageMime(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      )
    ).toBe('image/png');
    expect(
      detectedImageMime(
        new Uint8Array([
          0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
        ])
      )
    ).toBe('image/webp');
    expect(detectedImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBeNull();
  });
});
