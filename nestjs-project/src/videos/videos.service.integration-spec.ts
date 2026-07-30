import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import {
  ForbiddenVideoAccessException,
  VideoNotInDraftException,
} from '../common/exceptions/domain.exception';
import { User } from '../users/entities/user.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { Video } from './entities/video.entity';
import { VideoStatus } from './video-status.enum';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, Video];

describe('VideosService (integration)', () => {
  let dataSource: DataSource;
  let videosService: VideosService;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
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
          useFactory: (queue: ReturnType<typeof queueConfig>) => ({
            connection: { host: queue.host, port: queue.port },
          }),
        }),
        VideosModule,
      ],
    }).compile();

    videosService = module.get(VideosService);
    dataSource = module.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `vidsvc_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `vidsvc${counter}`,
        user_id: user.id,
      }),
    );
  }

  it('initiateUpload persists a DRAFT row with a unique slug owned by the caller channel', async () => {
    const channel = await createChannel();

    const result = await videosService.initiateUpload(channel.user_id, {
      title: 'Integration video',
      originalFilename: 'x.mp4',
      sizeBytes: 1000,
      contentType: 'video/mp4',
    });

    const stored = await videoRepository.findOne({
      where: { id: result.id },
    });
    expect(stored).not.toBeNull();
    expect(stored?.status).toBe(VideoStatus.DRAFT);
    expect(stored?.channel_id).toBe(channel.id);
    expect(stored?.slug).toBe(result.slug);
  }, 30000);

  it('completeUpload flips status to PROCESSING and enqueues a real job', async () => {
    const channel = await createChannel();
    const payload = Buffer.from('hello video bytes');
    const initiated = await videosService.initiateUpload(channel.user_id, {
      title: 'Integration video',
      originalFilename: 'x.mp4',
      sizeBytes: payload.length,
      contentType: 'video/mp4',
    });
    expect(initiated.parts).toHaveLength(1);

    const putResponse = await fetch(initiated.parts[0].url, {
      method: 'PUT',
      body: payload,
    });
    const eTag = putResponse.headers.get('etag') as string;

    const result = await videosService.completeUpload(
      channel.user_id,
      initiated.id,
      { parts: [{ partNumber: 1, eTag }] },
    );

    expect(result.status).toBe(VideoStatus.PROCESSING);

    const stored = await videoRepository.findOneOrFail({
      where: { id: initiated.id },
    });
    expect(stored.status).toBe(VideoStatus.PROCESSING);
    expect(stored.upload_id).toBeNull();

    const jobs = await queue.getJobs(['waiting']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].data).toEqual(
      expect.objectContaining({ videoId: initiated.id }),
    );
  }, 30000);

  it('abortUpload deletes the draft row', async () => {
    const channel = await createChannel();
    const initiated = await videosService.initiateUpload(channel.user_id, {
      title: 'Integration video',
      originalFilename: 'x.mp4',
      sizeBytes: 1,
      contentType: 'video/mp4',
    });

    await videosService.abortUpload(channel.user_id, initiated.id);

    const stored = await videoRepository.findOne({
      where: { id: initiated.id },
    });
    expect(stored).toBeNull();
  }, 30000);

  it('rejects operations from a user who does not own the video channel', async () => {
    const owner = await createChannel();
    const other = await createChannel();
    const initiated = await videosService.initiateUpload(owner.user_id, {
      title: 'Integration video',
      originalFilename: 'x.mp4',
      sizeBytes: 1,
      contentType: 'video/mp4',
    });

    await expect(
      videosService.abortUpload(other.user_id, initiated.id),
    ).rejects.toThrow(ForbiddenVideoAccessException);
  }, 30000);

  it('rejects completeUpload/abortUpload on a non-draft video', async () => {
    const channel = await createChannel();
    const initiated = await videosService.initiateUpload(channel.user_id, {
      title: 'Integration video',
      originalFilename: 'x.mp4',
      sizeBytes: 1,
      contentType: 'video/mp4',
    });
    await videoRepository.update(initiated.id, {
      status: VideoStatus.READY,
    });

    await expect(
      videosService.abortUpload(channel.user_id, initiated.id),
    ).rejects.toThrow(VideoNotInDraftException);
  }, 30000);
});
