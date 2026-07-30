import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../video-status.enum';

export class VideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  slug: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;

  @ApiProperty({ nullable: true, type: Number })
  durationSeconds: number | null;

  @ApiProperty()
  sizeBytes: string;

  @ApiProperty()
  contentType: string;

  @ApiProperty({ nullable: true, type: String })
  processingError: string | null;

  @ApiProperty()
  createdAt: Date;
}
