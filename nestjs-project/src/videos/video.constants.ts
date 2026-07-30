export const ALLOWED_VIDEO_CONTENT_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
] as const;

export const MAX_VIDEO_SIZE_BYTES = 10_737_418_240; // 10GB

export const MULTIPART_PART_SIZE_BYTES = 104_857_600; // 100MB, per TD-02

export const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
};
