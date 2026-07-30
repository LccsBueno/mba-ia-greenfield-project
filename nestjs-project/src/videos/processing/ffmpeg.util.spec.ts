import { computeThumbnailTimestamp } from './ffmpeg.util';

describe('computeThumbnailTimestamp', () => {
  it('returns 1 second for videos at least 2 seconds long', () => {
    expect(computeThumbnailTimestamp(2)).toBe(1);
    expect(computeThumbnailTimestamp(10)).toBe(1);
  });

  it('returns half the duration for videos shorter than 2 seconds', () => {
    expect(computeThumbnailTimestamp(1)).toBe(0.5);
    expect(computeThumbnailTimestamp(0.4)).toBeCloseTo(0.2);
  });
});
