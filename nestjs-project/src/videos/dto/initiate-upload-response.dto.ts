import { ApiProperty } from '@nestjs/swagger';

class PresignedPartDto {
  @ApiProperty({ example: 1 })
  partNumber: number;

  @ApiProperty()
  url: string;
}

export class InitiateUploadResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  slug: string;

  @ApiProperty({ example: 'draft' })
  status: string;

  @ApiProperty()
  uploadId: string;

  @ApiProperty({ type: [PresignedPartDto] })
  parts: PresignedPartDto[];
}
