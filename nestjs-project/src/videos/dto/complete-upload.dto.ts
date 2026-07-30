import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UploadPartDto {
  @ApiProperty({ example: 1 })
  @IsInt()
  @Min(1)
  partNumber: number;

  @ApiProperty({ example: '"9bb58f26192e4ba00f01e2e7b136bbd8"' })
  @IsString()
  @IsNotEmpty()
  eTag: string;
}

export class CompleteUploadDto {
  @ApiProperty({ type: [UploadPartDto] })
  @ValidateNested({ each: true })
  @Type(() => UploadPartDto)
  @ArrayMinSize(1)
  parts: UploadPartDto[];
}
