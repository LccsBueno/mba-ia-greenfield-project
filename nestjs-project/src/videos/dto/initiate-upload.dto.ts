import { IsIn, IsNotEmpty, IsNumber, Length, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import {
  ALLOWED_VIDEO_CONTENT_TYPES,
  MAX_VIDEO_SIZE_BYTES,
} from '../video.constants';

export class InitiateUploadDto {
  @ApiProperty({ example: 'My awesome video' })
  @Length(3, 120)
  title: string;

  @ApiProperty({ example: 'my-video.mp4' })
  @IsNotEmpty()
  originalFilename: string;

  @ApiProperty({ example: 104_857_600 })
  @IsNumber()
  @Min(1)
  @Max(MAX_VIDEO_SIZE_BYTES)
  sizeBytes: number;

  @ApiProperty({ example: 'video/mp4', enum: ALLOWED_VIDEO_CONTENT_TYPES })
  @IsIn(ALLOWED_VIDEO_CONTENT_TYPES)
  contentType: string;
}
