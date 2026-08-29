import { detectedImageMime, stageMediaUpload } from '@/lib/media-upload';

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

  it('fails closed before reading a file when the release upload gate is off', async () => {
    const result = await stageMediaUpload(
      { uri: 'file:///this-path-must-never-be-read.jpg', mimeType: 'image/jpeg' },
      'profile_banner',
    );

    expect(result).toEqual({
      ok: false,
      code: 'CONFIG_REQUIRED',
      reason: 'Photo uploads are not available in this release.',
    });
  });
});
