import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;

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
  async function registerConfirmAndLogin(): Promise<string> {
    const email = `video_e2e_${++userCounter}@example.com`;
    const password = 'password123';
    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        capturedToken = t;
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: capturedToken });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return res.body.access_token as string;
  }

  function initiateUpload(
    token: string,
    overrides: Record<string, unknown> = {},
  ) {
    return request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'My E2E video',
        originalFilename: 'video.mp4',
        sizeBytes: 11,
        contentType: 'video/mp4',
        ...overrides,
      });
  }

  describe('POST /videos/uploads', () => {
    it('returns 401 without an access token', async () => {
      await initiateUpload('').expect(401);
    });

    it('returns 400 for an unsupported content type', async () => {
      const token = await registerConfirmAndLogin();

      const res = await initiateUpload(token, { contentType: 'image/png' });

      expect(res.status).toBe(400);
    });

    it('returns 201 with a draft video, uploadId, and presigned parts, and sets Location', async () => {
      const token = await registerConfirmAndLogin();

      const res = await initiateUpload(token).expect(201);

      expect(res.body.status).toBe('draft');
      expect(res.body.slug).toBeDefined();
      expect(res.body.uploadId).toBeDefined();
      expect(res.body.parts).toHaveLength(1);
      expect(res.headers.location).toBe(`/videos/${res.body.id}`);
    });
  });

  describe('POST /videos/uploads/:id/complete', () => {
    it('returns 400 UPLOAD_PARTS_MISMATCH when parts do not match', async () => {
      const token = await registerConfirmAndLogin();
      const initiated = await initiateUpload(token).expect(201);

      // sizeBytes: 11 implies exactly 1 expected part — send 2 to trigger a
      // non-empty-but-wrong-count mismatch (an empty array is rejected by
      // DTO validation itself, before reaching this business rule).
      const res = await request(app.getHttpServer())
        .post(`/videos/uploads/${initiated.body.id}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          parts: [
            { partNumber: 1, eTag: '"a"' },
            { partNumber: 2, eTag: '"b"' },
          ],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('UPLOAD_PARTS_MISMATCH');
    });

    it('returns 200 with status processing after a valid completion', async () => {
      const token = await registerConfirmAndLogin();
      const payload = Buffer.from('hello world');
      const initiated = await initiateUpload(token, {
        sizeBytes: payload.length,
      }).expect(201);

      const putResponse = await fetch(initiated.body.parts[0].url, {
        method: 'PUT',
        body: payload,
      });
      const eTag = putResponse.headers.get('etag') as string;

      const res = await request(app.getHttpServer())
        .post(`/videos/uploads/${initiated.body.id}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ partNumber: 1, eTag }] });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('processing');
    });

    it('returns 403 when a non-owner tries to complete the upload', async () => {
      const ownerToken = await registerConfirmAndLogin();
      const otherToken = await registerConfirmAndLogin();
      const initiated = await initiateUpload(ownerToken).expect(201);

      const res = await request(app.getHttpServer())
        .post(`/videos/uploads/${initiated.body.id}/complete`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ parts: [{ partNumber: 1, eTag: '"x"' }] });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN_VIDEO_ACCESS');
    });

    it('returns 409 VIDEO_NOT_IN_DRAFT when the video is already processing', async () => {
      const token = await registerConfirmAndLogin();
      const payload = Buffer.from('hello world');
      const initiated = await initiateUpload(token, {
        sizeBytes: payload.length,
      }).expect(201);
      const putResponse = await fetch(initiated.body.parts[0].url, {
        method: 'PUT',
        body: payload,
      });
      const eTag = putResponse.headers.get('etag') as string;
      await request(app.getHttpServer())
        .post(`/videos/uploads/${initiated.body.id}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ partNumber: 1, eTag }] })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post(`/videos/uploads/${initiated.body.id}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ partNumber: 1, eTag }] });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('VIDEO_NOT_IN_DRAFT');
    });
  });

  describe('POST /videos/uploads/:id/abort', () => {
    it('returns 204 and deletes the draft video', async () => {
      const token = await registerConfirmAndLogin();
      const initiated = await initiateUpload(token).expect(201);

      await request(app.getHttpServer())
        .post(`/videos/uploads/${initiated.body.id}/abort`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      await request(app.getHttpServer())
        .get(`/videos/${initiated.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });
  });

  describe('GET /videos/:id', () => {
    it('returns 401 without an access token', async () => {
      await request(app.getHttpServer())
        .get('/videos/00000000-0000-0000-0000-000000000000')
        .expect(401);
    });

    it('returns 404 for an unknown video id', async () => {
      const token = await registerConfirmAndLogin();

      await request(app.getHttpServer())
        .get('/videos/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });

    it('returns 200 with the video metadata for the owner', async () => {
      const token = await registerConfirmAndLogin();
      const initiated = await initiateUpload(token).expect(201);

      const res = await request(app.getHttpServer())
        .get(`/videos/${initiated.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.id).toBe(initiated.body.id);
      expect(res.body.status).toBe('draft');
    });
  });
});
