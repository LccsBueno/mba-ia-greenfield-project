import { createWriteStream, promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { Repository } from 'typeorm';
import { VIDEO_PROCESSING_QUEUE } from '../../queue/queue.constants';
import type { VideoProcessingJobData } from '../../queue/video-queue.service';
import { buildThumbnailKey } from '../../storage/storage.constants';
import { StorageService } from '../../storage/storage.service';
import { Video } from '../entities/video.entity';
import { VideoStatus } from '../video-status.enum';
import {
  computeThumbnailTimestamp,
  extractThumbnail,
  probeVideo,
} from './ffmpeg.util';

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {
    super();
  }

  async process(job: Job<VideoProcessingJobData>): Promise<void> {
    const { videoId } = job.data;
    const video = await this.videoRepository.findOneOrFail({
      where: { id: videoId },
    });

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-'));
    const originalExt = path.extname(video.original_key) || '.bin';
    const originalPath = path.join(tempDir, `original${originalExt}`);
    const thumbnailPath = path.join(tempDir, 'thumbnail.jpg');

    try {
      const { body } = await this.storageService.getObject(video.original_key);
      await pipeline(body, createWriteStream(originalPath));

      const probe = await probeVideo(originalPath);
      const atSeconds = computeThumbnailTimestamp(probe.durationSeconds);
      await extractThumbnail(originalPath, thumbnailPath, atSeconds);

      const thumbnailBuffer = await fs.readFile(thumbnailPath);
      const thumbnailKey = buildThumbnailKey(video.channel_id, video.id);
      await this.storageService.putObject(
        thumbnailKey,
        thumbnailBuffer,
        'image/jpeg',
      );

      await this.videoRepository.update(video.id, {
        status: VideoStatus.READY,
        duration_seconds: Math.round(probe.durationSeconds),
        width: probe.width,
        height: probe.height,
        thumbnail_key: thumbnailKey,
        processing_error: null,
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<VideoProcessingJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;

    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) {
      // Not the final attempt — BullMQ will retry automatically.
      return;
    }

    this.logger.error(
      `Video ${job.data.videoId} processing failed after ${job.attemptsMade} attempts: ${error.message}`,
    );
    await this.videoRepository.update(job.data.videoId, {
      status: VideoStatus.ERROR,
      processing_error: error.message,
    });
  }
}
