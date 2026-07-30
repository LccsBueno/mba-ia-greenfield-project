import { buildOriginalKey, buildThumbnailKey } from './storage.constants';

describe('storage key builders', () => {
  it('should build the original video key', () => {
    expect(buildOriginalKey('chan-1', 'vid-1', 'mp4')).toBe(
      'channels/chan-1/videos/vid-1/original.mp4',
    );
  });

  it('should build the thumbnail key', () => {
    expect(buildThumbnailKey('chan-1', 'vid-1')).toBe(
      'channels/chan-1/videos/vid-1/thumbnail.jpg',
    );
  });
});
