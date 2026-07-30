import { generateVideoSlug } from './slug.util';

describe('generateVideoSlug', () => {
  it('should generate a 10-character hex slug', () => {
    const slug = generateVideoSlug();

    expect(slug).toHaveLength(10);
    expect(slug).toMatch(/^[0-9a-f]{10}$/);
  });

  it('should generate distinct slugs across calls', () => {
    const slugs = new Set(
      Array.from({ length: 20 }, () => generateVideoSlug()),
    );

    expect(slugs.size).toBe(20);
  });
});
