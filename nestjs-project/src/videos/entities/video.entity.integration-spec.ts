import { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { User } from '../../users/entities/user.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { Video } from './video.entity';
import { VideoStatus } from '../video-status.enum';

const ALL_ENTITIES = [User, Channel, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `chan_${counter}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(channelId: string, overrides: Partial<Video> = {}) {
    return videoRepository.create({
      channel_id: channelId,
      title: 'My Video',
      slug: `slug${++counter}`,
      original_key: `channels/${channelId}/videos/x/original.mp4`,
      content_type: 'video/mp4',
      size_bytes: '1000',
      ...overrides,
    });
  }

  it('should default status to draft', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(buildVideo(channel.id));

    expect(video.status).toBe(VideoStatus.DRAFT);
  });

  it('should enforce unique slug constraint', async () => {
    const channel = await createChannel();
    await videoRepository.save(buildVideo(channel.id, { slug: 'dupeslug1' }));

    await expect(
      videoRepository.save(buildVideo(channel.id, { slug: 'dupeslug1' })),
    ).rejects.toThrow();
  });

  it('should allow nullable columns to be null', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(
      buildVideo(channel.id, {
        thumbnail_key: null,
        upload_id: null,
        duration_seconds: null,
        width: null,
        height: null,
        processing_error: null,
      }),
    );

    expect(video.thumbnail_key).toBeNull();
    expect(video.duration_seconds).toBeNull();
  });

  it('should reject a video referencing a non-existent channel', async () => {
    await expect(
      videoRepository.save(buildVideo('00000000-0000-0000-0000-000000000000')),
    ).rejects.toThrow();
  });

  it('should load the related channel via the ManyToOne relation', async () => {
    const channel = await createChannel();
    await videoRepository.save(buildVideo(channel.id, { slug: 'relslug1' }));

    const found = await videoRepository.findOne({
      where: { slug: 'relslug1' },
      relations: ['channel'],
    });

    expect(found?.channel.id).toBe(channel.id);
  });
});
