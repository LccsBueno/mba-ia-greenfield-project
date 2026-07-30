import { QueryFailedError } from 'typeorm';
import {
  ForbiddenVideoAccessException,
  UploadPartsMismatchException,
  VideoNotFoundException,
  VideoNotInDraftException,
} from '../common/exceptions/domain.exception';
import { VideoStatus } from './video-status.enum';
import { VideosService } from './videos.service';

function makeVideoRepository(overrides: Record<string, jest.Mock> = {}): any {
  return {
    create: jest.fn((v: any) => v),
    save: jest.fn(),
    findOne: jest.fn(),
    remove: jest.fn(),
    ...overrides,
  };
}

function makeChannelsService(overrides: Record<string, jest.Mock> = {}): any {
  return {
    findByUserId: jest.fn(),
    ...overrides,
  };
}

function makeStorageService(overrides: Record<string, jest.Mock> = {}): any {
  return {
    createMultipartUpload: jest.fn(),
    presignUploadPart: jest.fn(),
    completeMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
    ...overrides,
  };
}

function makeQueueService(overrides: Record<string, jest.Mock> = {}): any {
  return {
    enqueueProcessing: jest.fn(),
    ...overrides,
  };
}

function makeUniqueSlugError(): QueryFailedError {
  const err = new QueryFailedError('INSERT', [], new Error()) as any;
  err.code = '23505';
  err.detail = 'Key (slug)=(abc) already exists.';
  return err;
}

function makeVideo(overrides: Partial<any> = {}): any {
  return {
    id: 'video-1',
    channel: { id: 'chan-1', user_id: 'user-1' },
    channel_id: 'chan-1',
    slug: 'slug1',
    title: 'Title',
    status: VideoStatus.DRAFT,
    original_key: 'channels/chan-1/videos/video-1/original.mp4',
    upload_id: 'upload-1',
    content_type: 'video/mp4',
    size_bytes: '200000000', // 2 parts at 100MB
    duration_seconds: null,
    processing_error: null,
    created_at: new Date(),
    ...overrides,
  };
}

describe('VideosService', () => {
  describe('initiateUpload', () => {
    it('computes the expected number of presigned parts', async () => {
      const videoRepository = makeVideoRepository({
        save: jest.fn((v: any) => Promise.resolve(v)),
      });
      const storageService = makeStorageService({
        createMultipartUpload: jest
          .fn()
          .mockResolvedValue({ uploadId: 'up-1' }),
        presignUploadPart: jest
          .fn()
          .mockImplementation((_k, _u, part) =>
            Promise.resolve(`https://minio/part-${part}`),
          ),
      });
      const channelsService = makeChannelsService({
        findByUserId: jest.fn().mockResolvedValue({ id: 'chan-1' }),
      });
      const service = new VideosService(
        videoRepository,
        channelsService,
        storageService,
        makeQueueService(),
      );

      const result = await service.initiateUpload('user-1', {
        title: 'My video',
        originalFilename: 'x.mp4',
        sizeBytes: 250_000_000, // 3 parts at 100MB
        contentType: 'video/mp4',
      });

      expect(result.parts).toHaveLength(3);
      expect(result.parts.map((p) => p.partNumber)).toEqual([1, 2, 3]);
      expect(result.uploadId).toBe('up-1');
    });

    it('retries slug generation on unique-constraint violation', async () => {
      const videoRepository = makeVideoRepository({
        save: jest
          .fn()
          .mockRejectedValueOnce(makeUniqueSlugError())
          .mockImplementationOnce((v: any) => Promise.resolve(v))
          .mockImplementationOnce((v: any) => Promise.resolve(v)),
      });
      const storageService = makeStorageService({
        createMultipartUpload: jest
          .fn()
          .mockResolvedValue({ uploadId: 'up-1' }),
        presignUploadPart: jest.fn().mockResolvedValue('https://minio/x'),
      });
      const channelsService = makeChannelsService({
        findByUserId: jest.fn().mockResolvedValue({ id: 'chan-1' }),
      });
      const service = new VideosService(
        videoRepository,
        channelsService,
        storageService,
        makeQueueService(),
      );

      const result = await service.initiateUpload('user-1', {
        title: 'My video',
        originalFilename: 'x.mp4',
        sizeBytes: 1000,
        contentType: 'video/mp4',
      });

      // 1 failed attempt (unique violation) + 1 successful create + 1 upload_id update
      expect(videoRepository.save).toHaveBeenCalledTimes(3);
      expect(result.id).toBeDefined();
    });

    it('throws VideoNotFoundException when the caller has no channel', async () => {
      const channelsService = makeChannelsService({
        findByUserId: jest.fn().mockResolvedValue(null),
      });
      const service = new VideosService(
        makeVideoRepository(),
        channelsService,
        makeStorageService(),
        makeQueueService(),
      );

      await expect(
        service.initiateUpload('user-1', {
          title: 'x',
          originalFilename: 'x.mp4',
          sizeBytes: 100,
          contentType: 'video/mp4',
        }),
      ).rejects.toThrow(VideoNotFoundException);
    });
  });

  describe('ownership and status guards', () => {
    it('completeUpload throws ForbiddenVideoAccessException for another user', async () => {
      const video = makeVideo({ channel: { id: 'c', user_id: 'owner' } });
      const videoRepository = makeVideoRepository({
        findOne: jest.fn().mockResolvedValue(video),
      });
      const service = new VideosService(
        videoRepository,
        makeChannelsService(),
        makeStorageService(),
        makeQueueService(),
      );

      await expect(
        service.completeUpload('someone-else', video.id, { parts: [] }),
      ).rejects.toThrow(ForbiddenVideoAccessException);
    });

    it('completeUpload throws VideoNotFoundException for unknown id', async () => {
      const videoRepository = makeVideoRepository({
        findOne: jest.fn().mockResolvedValue(null),
      });
      const service = new VideosService(
        videoRepository,
        makeChannelsService(),
        makeStorageService(),
        makeQueueService(),
      );

      await expect(
        service.completeUpload('user-1', 'unknown', { parts: [] }),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('completeUpload throws VideoNotInDraftException when not draft', async () => {
      const video = makeVideo({ status: VideoStatus.READY });
      const videoRepository = makeVideoRepository({
        findOne: jest.fn().mockResolvedValue(video),
      });
      const service = new VideosService(
        videoRepository,
        makeChannelsService(),
        makeStorageService(),
        makeQueueService(),
      );

      await expect(
        service.completeUpload('user-1', video.id, {
          parts: [
            { partNumber: 1, eTag: 'x' },
            { partNumber: 2, eTag: 'y' },
          ],
        }),
      ).rejects.toThrow(VideoNotInDraftException);
    });

    it('completeUpload throws UploadPartsMismatchException on wrong part count', async () => {
      const video = makeVideo(); // size implies 2 parts
      const videoRepository = makeVideoRepository({
        findOne: jest.fn().mockResolvedValue(video),
      });
      const service = new VideosService(
        videoRepository,
        makeChannelsService(),
        makeStorageService(),
        makeQueueService(),
      );

      await expect(
        service.completeUpload('user-1', video.id, {
          parts: [{ partNumber: 1, eTag: 'x' }],
        }),
      ).rejects.toThrow(UploadPartsMismatchException);
    });

    it('completeUpload enqueues processing and flips status only after storage completes', async () => {
      const video = makeVideo();
      const videoRepository = makeVideoRepository({
        findOne: jest.fn().mockResolvedValue(video),
        save: jest.fn((v: any) => Promise.resolve(v)),
      });
      const storageService = makeStorageService({
        completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      });
      const queueService = makeQueueService();
      const service = new VideosService(
        videoRepository,
        makeChannelsService(),
        storageService,
        queueService,
      );

      const result = await service.completeUpload('user-1', video.id, {
        parts: [
          { partNumber: 1, eTag: 'x' },
          { partNumber: 2, eTag: 'y' },
        ],
      });

      expect(storageService.completeMultipartUpload).toHaveBeenCalled();
      expect(queueService.enqueueProcessing).toHaveBeenCalledWith(video.id);
      expect(result.status).toBe(VideoStatus.PROCESSING);
    });

    it('abortUpload deletes the row and aborts storage for a draft video', async () => {
      const video = makeVideo();
      const videoRepository = makeVideoRepository({
        findOne: jest.fn().mockResolvedValue(video),
      });
      const storageService = makeStorageService();
      const service = new VideosService(
        videoRepository,
        makeChannelsService(),
        storageService,
        makeQueueService(),
      );

      await service.abortUpload('user-1', video.id);

      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        video.original_key,
        video.upload_id,
      );
      expect(videoRepository.remove).toHaveBeenCalledWith(video);
    });

    it('abortUpload throws VideoNotInDraftException when not draft', async () => {
      const video = makeVideo({ status: VideoStatus.PROCESSING });
      const videoRepository = makeVideoRepository({
        findOne: jest.fn().mockResolvedValue(video),
      });
      const service = new VideosService(
        videoRepository,
        makeChannelsService(),
        makeStorageService(),
        makeQueueService(),
      );

      await expect(service.abortUpload('user-1', video.id)).rejects.toThrow(
        VideoNotInDraftException,
      );
    });

    it('getVideo returns the response shape for the owner', async () => {
      const video = makeVideo();
      const videoRepository = makeVideoRepository({
        findOne: jest.fn().mockResolvedValue(video),
      });
      const service = new VideosService(
        videoRepository,
        makeChannelsService(),
        makeStorageService(),
        makeQueueService(),
      );

      const result = await service.getVideo('user-1', video.id);

      expect(result).toEqual({
        id: video.id,
        slug: video.slug,
        title: video.title,
        status: video.status,
        durationSeconds: video.duration_seconds,
        sizeBytes: video.size_bytes,
        contentType: video.content_type,
        processingError: video.processing_error,
        createdAt: video.created_at,
      });
    });
  });
});
