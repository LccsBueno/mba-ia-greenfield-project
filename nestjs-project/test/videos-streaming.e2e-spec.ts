import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video } from '../src/videos/entities/video.entity';
import { VideoStatus } from '../src/videos/video-status.enum';

describe('Videos streaming/download (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;

  const payload = Buffer.from('0123456789'.repeat(20)); // 200 bytes

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
    storageService = moduleFixture.get(StorageService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  let userCounter = 0;
  async function registerConfirmAndLogin(): Promise<{
    token: string;
    userId: string;
  }> {
    const email = `stream_e2e_${++userCounter}@example.com`;
    const password = 'password123';
    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        capturedToken = t;
      });
    const registerRes = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: capturedToken });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return {
      token: res.body.access_token as string,
      userId: registerRes.body.id as string,
    };
  }

  async function createReadyVideo(
    userId: string,
    overrides: Partial<Video> = {},
  ): Promise<Video> {
    const channel = await channelRepository.findOneOrFail({
      where: { user_id: userId },
    });
    const videoId = randomUUID();
    const key = `channels/${channel.id}/videos/${videoId}/original.mp4`;
    await storageService.putObject(key, payload, 'video/mp4');
    return videoRepository.save(
      videoRepository.create({
        id: videoId,
        channel_id: channel.id,
        title: 'Ready video',
        slug: videoId.replace(/-/g, '').slice(0, 10),
        status: VideoStatus.READY,
        original_key: key,
        content_type: 'video/mp4',
        size_bytes: String(payload.length),
        duration_seconds: 2,
        ...overrides,
      }),
    );
  }

  describe('GET /videos/:slug/stream', () => {
    it('returns 200 with the full body and Accept-Ranges when no Range is requested', async () => {
      const { token, userId } = await registerConfirmAndLogin();
      const video = await createReadyVideo(userId);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.slug}/stream`)
        .set('Authorization', `Bearer ${token}`)
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => callback(null, Buffer.concat(chunks)));
        });

      expect(res.status).toBe(200);
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect((res.body as Buffer).equals(payload)).toBe(true);
    });

    it('returns 206 with a Content-Range for a Range request', async () => {
      const { token, userId } = await registerConfirmAndLogin();
      const video = await createReadyVideo(userId);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.slug}/stream`)
        .set('Authorization', `Bearer ${token}`)
        .set('Range', 'bytes=0-99')
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => callback(null, Buffer.concat(chunks)));
        });

      expect(res.status).toBe(206);
      expect(res.headers['content-range']).toBe(`bytes 0-99/${payload.length}`);
      expect((res.body as Buffer).length).toBe(100);
      expect((res.body as Buffer).equals(payload.subarray(0, 100))).toBe(true);
    });

    it('returns 409 VIDEO_NOT_READY for a draft video', async () => {
      const { token, userId } = await registerConfirmAndLogin();
      const video = await createReadyVideo(userId, {
        status: VideoStatus.DRAFT,
      });

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.slug}/stream`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('VIDEO_NOT_READY');
    });

    it('returns 403 for a non-owner', async () => {
      const owner = await registerConfirmAndLogin();
      const other = await registerConfirmAndLogin();
      const video = await createReadyVideo(owner.userId);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.slug}/stream`)
        .set('Authorization', `Bearer ${other.token}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN_VIDEO_ACCESS');
    });

    it('returns 404 for an unknown slug', async () => {
      const { token } = await registerConfirmAndLogin();

      const res = await request(app.getHttpServer())
        .get('/videos/unknownslug/stream')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('GET /videos/:slug/download', () => {
    it('returns 200 with Content-Disposition attachment and the full body', async () => {
      const { token, userId } = await registerConfirmAndLogin();
      const video = await createReadyVideo(userId);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.slug}/download`)
        .set('Authorization', `Bearer ${token}`)
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => callback(null, Buffer.concat(chunks)));
        });

      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toContain('attachment');
      expect((res.body as Buffer).equals(payload)).toBe(true);
    });

    it('returns 409 VIDEO_NOT_READY for a processing video', async () => {
      const { token, userId } = await registerConfirmAndLogin();
      const video = await createReadyVideo(userId, {
        status: VideoStatus.PROCESSING,
      });

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.slug}/download`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('VIDEO_NOT_READY');
    });
  });
});
