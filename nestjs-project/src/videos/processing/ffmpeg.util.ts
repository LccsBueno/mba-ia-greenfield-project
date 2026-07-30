import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 30_000;
const THUMBNAIL_TIMEOUT_MS = 30_000;

export interface VideoProbeResult {
  durationSeconds: number;
  width: number | null;
  height: number | null;
}

interface FfprobeStream {
  codec_type: string;
  width?: number;
  height?: number;
}

interface FfprobeOutput {
  streams: FfprobeStream[];
  format: { duration?: string };
}

export async function probeVideo(filePath: string): Promise<VideoProbeResult> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ],
    { timeout: PROBE_TIMEOUT_MS },
  );

  const parsed = JSON.parse(stdout) as FfprobeOutput;
  const durationSeconds = Number(parsed.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`Could not determine video duration for ${filePath}`);
  }

  const videoStream = parsed.streams?.find((s) => s.codec_type === 'video');

  return {
    durationSeconds,
    width: videoStream?.width ?? null,
    height: videoStream?.height ?? null,
  };
}

export function computeThumbnailTimestamp(durationSeconds: number): number {
  return durationSeconds < 2 ? durationSeconds / 2 : 1;
}

export async function extractThumbnail(
  filePath: string,
  outputPath: string,
  atSeconds: number,
): Promise<void> {
  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-ss',
      String(atSeconds),
      '-i',
      filePath,
      '-vframes',
      '1',
      outputPath,
    ],
    { timeout: THUMBNAIL_TIMEOUT_MS },
  );
}
