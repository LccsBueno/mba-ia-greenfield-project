import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  ForbiddenVideoAccessException,
  UploadPartsMismatchException,
  VideoNotFoundException,
  VideoNotInDraftException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { VideoQueueService } from '../queue/video-queue.service';
import { buildOriginalKey } from '../storage/storage.constants';
import { GetObjectResult, StorageService } from '../storage/storage.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { InitiateUploadResponseDto } from './dto/initiate-upload-response.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { Video } from './entities/video.entity';
import { generateVideoSlug } from './slug.util';
import { VideoStatus } from './video-status.enum';
import {
  EXTENSION_BY_CONTENT_TYPE,
  MULTIPART_PART_SIZE_BYTES,
} from './video.constants';

const PG_UNIQUE_VIOLATION = '23505';
const MAX_SLUG_RETRIES = 5;

function isSlugUniqueViolation(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const e = err as unknown as { code?: string; detail?: string };
  return e.code === PG_UNIQUE_VIOLATION && !!e.detail?.includes('slug');
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    private readonly videoQueueService: VideoQueueService,
  ) {}

  private async findOwnedVideoOrThrow(
    userId: string,
    videoId: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
      relations: ['channel'],
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.channel.user_id !== userId) {
      throw new ForbiddenVideoAccessException();
    }
    return video;
  }

  private async findOwnedVideoBySlugOrThrow(
    userId: string,
    slug: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { slug },
      relations: ['channel'],
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.channel.user_id !== userId) {
      throw new ForbiddenVideoAccessException();
    }
    return video;
  }

  async initiateUpload(
    userId: string,
    dto: InitiateUploadDto,
  ): Promise<InitiateUploadResponseDto> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new VideoNotFoundException();
    }

    const ext = EXTENSION_BY_CONTENT_TYPE[dto.contentType] ?? 'bin';
    const partCount = Math.ceil(dto.sizeBytes / MULTIPART_PART_SIZE_BYTES);

    const videoId = randomUUID();
    const originalKey = buildOriginalKey(channel.id, videoId, ext);
    let video: Video | undefined;
    let slug = generateVideoSlug();

    for (let attempt = 0; attempt <= MAX_SLUG_RETRIES; attempt++) {
      const draft = this.videoRepository.create({
        id: videoId,
        channel_id: channel.id,
        title: dto.title,
        slug,
        original_key: originalKey,
        content_type: dto.contentType,
        size_bytes: String(dto.sizeBytes),
      });
      try {
        video = await this.videoRepository.save(draft);
        break;
      } catch (err) {
        if (isSlugUniqueViolation(err) && attempt < MAX_SLUG_RETRIES) {
          slug = generateVideoSlug();
          continue;
        }
        throw err;
      }
    }
    if (!video) {
      throw new Error('Could not create video after slug retries');
    }

    const { uploadId } = await this.storageService.createMultipartUpload(
      originalKey,
      dto.contentType,
    );

    const parts = await Promise.all(
      Array.from({ length: partCount }, (_, i) => i + 1).map(
        async (partNumber) => ({
          partNumber,
          url: await this.storageService.presignUploadPart(
            originalKey,
            uploadId,
            partNumber,
          ),
        }),
      ),
    );

    video.upload_id = uploadId;
    await this.videoRepository.save(video);

    return {
      id: video.id,
      slug: video.slug,
      status: video.status,
      uploadId,
      parts,
    };
  }

  async completeUpload(
    userId: string,
    videoId: string,
    dto: CompleteUploadDto,
  ): Promise<VideoResponseDto> {
    const video = await this.findOwnedVideoOrThrow(userId, videoId);
    if (video.status !== VideoStatus.DRAFT) {
      throw new VideoNotInDraftException();
    }

    const expectedPartCount = Math.ceil(
      Number(video.size_bytes) / MULTIPART_PART_SIZE_BYTES,
    );
    if (dto.parts.length !== expectedPartCount) {
      throw new UploadPartsMismatchException();
    }

    await this.storageService.completeMultipartUpload(
      video.original_key,
      video.upload_id as string,
      dto.parts,
    );

    video.status = VideoStatus.PROCESSING;
    video.upload_id = null;
    const saved = await this.videoRepository.save(video);

    await this.videoQueueService.enqueueProcessing(saved.id);

    return this.toResponseDto(saved);
  }

  async abortUpload(userId: string, videoId: string): Promise<void> {
    const video = await this.findOwnedVideoOrThrow(userId, videoId);
    if (video.status !== VideoStatus.DRAFT) {
      throw new VideoNotInDraftException();
    }

    await this.storageService.abortMultipartUpload(
      video.original_key,
      video.upload_id as string,
    );
    await this.videoRepository.remove(video);
  }

  async getVideo(userId: string, videoId: string): Promise<VideoResponseDto> {
    const video = await this.findOwnedVideoOrThrow(userId, videoId);
    return this.toResponseDto(video);
  }

  async streamVideo(
    userId: string,
    slug: string,
    range?: string,
  ): Promise<{ result: GetObjectResult; video: Video }> {
    const video = await this.findOwnedVideoBySlugOrThrow(userId, slug);
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }
    const result = await this.storageService.getObject(
      video.original_key,
      range,
    );
    return { result, video };
  }

  async downloadVideo(
    userId: string,
    slug: string,
  ): Promise<{ result: GetObjectResult; video: Video }> {
    const video = await this.findOwnedVideoBySlugOrThrow(userId, slug);
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }
    const result = await this.storageService.getObject(video.original_key);
    return { result, video };
  }

  private toResponseDto(video: Video): VideoResponseDto {
    return {
      id: video.id,
      slug: video.slug,
      title: video.title,
      status: video.status,
      durationSeconds: video.duration_seconds,
      sizeBytes: video.size_bytes,
      contentType: video.content_type,
      processingError: video.processing_error,
      createdAt: video.created_at,
    };
  }
}
