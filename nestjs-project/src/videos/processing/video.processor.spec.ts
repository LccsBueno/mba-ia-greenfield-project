import { writeFile } from 'fs/promises';
import { Readable } from 'stream';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { Repository } from 'typeorm';
import { StorageService } from '../../storage/storage.service';
import { Video } from '../entities/video.entity';
import { VideoStatus } from '../video-status.enum';
import * as ffmpegUtil from './ffmpeg.util';
import { VideoProcessor } from './video.processor';

jest.mock('./ffmpeg.util');

describe('VideoProcessor', () => {
  let processor: VideoProcessor;
  let videoRepository: jest.Mocked<Repository<Video>>;
  let storageService: jest.Mocked<StorageService>;

  const video = {
    id: 'video-1',
    channel_id: 'chan-1',
    original_key: 'channels/chan-1/videos/video-1/original.mp4',
  } as Video;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module = await Test.createTestingModule({
      providers: [
        VideoProcessor,
        {
          provide: getRepositoryToken(Video),
          useValue: {
            findOneOrFail: jest.fn().mockResolvedValue(video),
            update: jest.fn(),
          },
        },
        {
          provide: StorageService,
          useValue: {
            getObject: jest.fn(),
            putObject: jest.fn(),
          },
        },
      ],
    }).compile();

    processor = module.get(VideoProcessor);
    videoRepository = module.get(getRepositoryToken(Video));
    storageService = module.get(StorageService);
  });

  describe('process', () => {
    it('probes, extracts a thumbnail, uploads it, and marks the video READY', async () => {
      storageService.getObject.mockResolvedValue({
        body: Readable.from([Buffer.from('fake video bytes')]),
        contentLength: 17,
        contentRange: undefined,
        statusCode: 200,
      });
      (ffmpegUtil.probeVideo as jest.Mock).mockResolvedValue({
        durationSeconds: 5,
        width: 640,
        height: 480,
      });
      (ffmpegUtil.computeThumbnailTimestamp as jest.Mock).mockReturnValue(1);
      (ffmpegUtil.extractThumbnail as jest.Mock).mockImplementation(
        async (_input: string, outputPath: string) => {
          await writeFile(outputPath, Buffer.from('fake-thumbnail'));
        },
      );

      const job = {
        data: { videoId: 'video-1' },
      } as Job<{ videoId: string }>;

      await processor.process(job);

      expect(storageService.putObject).toHaveBeenCalledWith(
        'channels/chan-1/videos/video-1/thumbnail.jpg',
        expect.any(Buffer),
        'image/jpeg',
      );
      expect(videoRepository.update).toHaveBeenCalledWith('video-1', {
        status: VideoStatus.READY,
        duration_seconds: 5,
        width: 640,
        height: 480,
        thumbnail_key: 'channels/chan-1/videos/video-1/thumbnail.jpg',
        processing_error: null,
      });
    });
  });

  describe('onFailed', () => {
    it('does nothing when more retry attempts remain', async () => {
      const job = {
        data: { videoId: 'video-1' },
        attemptsMade: 1,
        opts: { attempts: 3 },
      } as Job<{ videoId: string }>;

      await processor.onFailed(job, new Error('transient'));

      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('marks the video ERROR once attempts are exhausted', async () => {
      const job = {
        data: { videoId: 'video-1' },
        attemptsMade: 3,
        opts: { attempts: 3 },
      } as Job<{ videoId: string }>;

      await processor.onFailed(job, new Error('final failure'));

      expect(videoRepository.update).toHaveBeenCalledWith('video-1', {
        status: VideoStatus.ERROR,
        processing_error: 'final failure',
      });
    });

    it('does nothing when job is undefined', async () => {
      await processor.onFailed(undefined, new Error('x'));

      expect(videoRepository.update).not.toHaveBeenCalled();
    });
  });
});
