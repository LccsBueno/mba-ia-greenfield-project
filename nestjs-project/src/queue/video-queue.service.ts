import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { VIDEO_PROCESSING_QUEUE } from './queue.constants';

export interface VideoProcessingJobData {
  videoId: string;
}

@Injectable()
export class VideoQueueService {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue<VideoProcessingJobData>,
  ) {}

  async enqueueProcessing(videoId: string): Promise<void> {
    await this.queue.add(
      'process',
      { videoId },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      },
    );
  }
}
