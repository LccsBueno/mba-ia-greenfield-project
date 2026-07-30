import { randomBytes } from 'crypto';

const SLUG_LENGTH = 10;

export function generateVideoSlug(): string {
  return randomBytes(Math.ceil(SLUG_LENGTH / 2))
    .toString('hex')
    .slice(0, SLUG_LENGTH);
}
