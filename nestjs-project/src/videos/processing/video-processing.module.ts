import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VIDEO_PROCESSING_QUEUE } from '../../queue/queue.constants';
import { StorageModule } from '../../storage/storage.module';
import { Video } from '../entities/video.entity';
import { VideoProcessor } from './video.processor';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    StorageModule,
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
  ],
  providers: [VideoProcessor],
})
export class VideoProcessingModule {}
