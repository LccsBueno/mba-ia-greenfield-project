import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { InitiateUploadResponseDto } from './dto/initiate-upload-response.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { EXTENSION_BY_CONTENT_TYPE } from './video.constants';
import { VideosService } from './videos.service';

@ApiTags('videos')
@ApiBearerAuth('access-token')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post('uploads')
  @ApiOperation({
    summary: 'Initiate a video upload',
    description:
      'Creates the video as a draft owned by the caller channel and returns presigned URLs for each multipart part.',
  })
  @ApiResponse({
    status: 201,
    description: 'Upload initiated',
    type: InitiateUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InitiateUploadResponseDto> {
    const result = await this.videosService.initiateUpload(user.sub, dto);
    res.setHeader('Location', `/videos/${result.id}`);
    return result;
  }

  @Post('uploads/:id/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Finalizes the multipart upload against storage and enqueues background processing.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed, processing started',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or parts mismatch',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Caller does not own this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in draft status',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<VideoResponseDto> {
    return this.videosService.completeUpload(user.sub, id, dto);
  }

  @Post('uploads/:id/abort')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Abort a video upload',
    description:
      'Aborts the in-progress multipart upload and deletes the draft video.',
  })
  @ApiResponse({ status: 204, description: 'Upload aborted' })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Caller does not own this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in draft status',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ): Promise<void> {
    return this.videosService.abortUpload(user.sub, id);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get video metadata/status',
    description: "Returns the video's status and metadata for its owner.",
  })
  @ApiResponse({
    status: 200,
    description: 'Video metadata',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Caller does not own this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getVideo(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ): Promise<VideoResponseDto> {
    return this.videosService.getVideo(user.sub, id);
  }

  @Get(':slug/stream')
  @ApiParam({ name: 'slug', description: 'Video public slug' })
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Proxies bytes from object storage, supporting Range requests (206 Partial Content) so playback does not require downloading the full file.',
  })
  @ApiResponse({ status: 200, description: 'Full video body (no Range)' })
  @ApiResponse({
    status: 206,
    description: 'Partial video body (Range requested)',
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Caller does not own this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for playback',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async streamVideo(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
    @Headers('range') range: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const { result, video } = await this.videosService.streamVideo(
      user.sub,
      slug,
      range,
    );

    res.setHeader('Content-Type', video.content_type);
    res.setHeader('Accept-Ranges', 'bytes');

    if (range && result.statusCode === 206) {
      res.status(206);
      if (result.contentRange) {
        res.setHeader('Content-Range', result.contentRange);
      }
    } else {
      res.status(200);
    }
    if (result.contentLength !== undefined) {
      res.setHeader('Content-Length', result.contentLength);
    }

    result.body.on('error', () => res.destroy());
    result.body.pipe(res);
  }

  @Get(':slug/download')
  @ApiParam({ name: 'slug', description: 'Video public slug' })
  @ApiOperation({
    summary: 'Download a video',
    description: 'Serves the full video file as an attachment.',
  })
  @ApiResponse({ status: 200, description: 'Full video body' })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Caller does not own this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for playback',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async downloadVideo(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
    @Res() res: Response,
  ): Promise<void> {
    const { result, video } = await this.videosService.downloadVideo(
      user.sub,
      slug,
    );

    const ext = EXTENSION_BY_CONTENT_TYPE[video.content_type] ?? 'bin';
    res.setHeader('Content-Type', video.content_type);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${video.title.replace(/[^a-zA-Z0-9-_ ]/g, '')}.${ext}"`,
    );
    if (result.contentLength !== undefined) {
      res.setHeader('Content-Length', result.contentLength);
    }

    result.body.on('error', () => res.destroy());
    result.body.pipe(res);
  }
}
