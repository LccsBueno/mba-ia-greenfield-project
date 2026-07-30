import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { VIDEO_PROCESSING_QUEUE } from './queue.constants';
import { VideoQueueModule } from './video-queue.module';
import { VideoQueueService } from './video-queue.service';

describe('VideoQueueService (integration)', () => {
  let videoQueueService: VideoQueueService;
  let queue: Queue;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        BullModule.forRootAsync({
          imports: [ConfigModule],
          inject: [queueConfig.KEY],
          useFactory: (config: ConfigType<typeof queueConfig>) => ({
            connection: { host: config.host, port: config.port },
          }),
        }),
        VideoQueueModule,
      ],
    }).compile();

    videoQueueService = module.get(VideoQueueService);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
  });

  it('enqueues a job with the correct data and retry options', async () => {
    const videoId = randomUUID();

    await videoQueueService.enqueueProcessing(videoId);

    const jobs = await queue.getJobs(['waiting', 'delayed']);
    const job = jobs.find((j) => j.data.videoId === videoId);

    expect(job).toBeDefined();
    expect(job!.name).toBe('process');
    expect(job!.opts.attempts).toBe(3);
    expect(job!.opts.backoff).toEqual({ type: 'exponential', delay: 5000 });
  });
});
