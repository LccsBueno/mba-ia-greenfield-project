export const S3_CLIENT = 'S3_CLIENT';

export function buildOriginalKey(
  channelId: string,
  videoId: string,
  ext: string,
): string {
  return `channels/${channelId}/videos/${videoId}/original.${ext}`;
}

export function buildThumbnailKey(channelId: string, videoId: string): string {
  return `channels/${channelId}/videos/${videoId}/thumbnail.jpg`;
}
