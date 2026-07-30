import { readFile } from 'fs/promises';
import { join } from 'path';
import { INestApplicationContext } from '@nestjs/common';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import queueConfig from '../../config/queue.config';
import storageConfig from '../../config/storage.config';
import { VIDEO_PROCESSING_QUEUE } from '../../queue/queue.constants';
import { StorageService } from '../../storage/storage.service';
import { StorageModule } from '../../storage/storage.module';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video } from '../entities/video.entity';
import { VideoStatus } from '../video-status.enum';
import { VideoProcessingModule } from './video-processing.module';

const ALL_ENTITIES = [User, Channel, Video];
const FIXTURE_PATH = join(__dirname, '../../../test/fixtures/sample-video.mp4');

async function waitForStatus(
  videoRepository: Repository<Video>,
  videoId: string,
  timeoutMs: number,
): Promise<Video> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const video = await videoRepository.findOneOrFail({
      where: { id: videoId },
    });
    if (video.status !== VideoStatus.PROCESSING) {
      return video;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(
    `Timed out waiting for video ${videoId} to finish processing`,
  );
}

describe('VideoProcessor (integration)', () => {
  let app: INestApplicationContext;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;
  let queue: Queue;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        BullModule.forRootAsync({
          inject: [queueConfig.KEY],
          useFactory: (config: ReturnType<typeof queueConfig>) => ({
            connection: { host: config.host, port: config.port },
          }),
        }),
        StorageModule,
        VideoProcessingModule,
      ],
    }).compile();

    // .compile() alone does not run onModuleInit — @nestjs/bullmq's
    // WorkerHost (and StorageService's bucket bootstrap) only start once the
    // application context is actually initialized.
    app = module.createNestApplication();
    await app.init();

    dataSource = app.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
    storageService = app.get(StorageService);
    queue = app.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
  });

  let counter = 0;
  async function createVideoRow(
    overrides: Partial<Video> = {},
  ): Promise<Video> {
    const user = await userRepository.save(
      userRepository.create({
        email: `processor_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `proc${counter}`,
        user_id: user.id,
      }),
    );
    return videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'Processing test video',
        slug: `proc${counter}`,
        status: VideoStatus.PROCESSING,
        original_key: `channels/${channel.id}/videos/proc-${counter}/original.mp4`,
        content_type: 'video/mp4',
        size_bytes: '22312',
        ...overrides,
      }),
    );
  }

  it('processes a real fixture video: extracts duration/dimensions, generates a thumbnail, and marks it READY', async () => {
    const video = await createVideoRow();
    const fixtureBuffer = await readFile(FIXTURE_PATH);
    await storageService.putObject(
      video.original_key,
      fixtureBuffer,
      'video/mp4',
    );

    await queue.add('process', { videoId: video.id });

    const finished = await waitForStatus(videoRepository, video.id, 20000);

    expect(finished.status).toBe(VideoStatus.READY);
    expect(finished.duration_seconds).toBe(2);
    expect(finished.width).toBe(64);
    expect(finished.height).toBe(64);
    expect(finished.thumbnail_key).toBe(
      `channels/${video.channel_id}/videos/${video.id}/thumbnail.jpg`,
    );
    expect(finished.processing_error).toBeNull();

    const thumbnail = await storageService.getObject(
      finished.thumbnail_key as string,
    );
    expect(thumbnail.contentLength).toBeGreaterThan(0);
  }, 30000);

  it('marks the video ERROR after exhausting retries when the original object is missing', async () => {
    const video = await createVideoRow({
      original_key: 'channels/missing/videos/missing/original.mp4',
    });

    await queue.add(
      'process',
      { videoId: video.id },
      { attempts: 2, backoff: { type: 'fixed', delay: 500 } },
    );

    const finished = await waitForStatus(videoRepository, video.id, 20000);

    expect(finished.status).toBe(VideoStatus.ERROR);
    expect(finished.processing_error).toBeTruthy();
  }, 30000);
});
