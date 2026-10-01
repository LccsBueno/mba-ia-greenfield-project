import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VIDEO_PROCESSING_QUEUE } from '../../queue/queue.constants';
import { Channel } from '../../channels/entities/channel.entity';
import { StorageModule } from '../../storage/storage.module';
import { User } from '../../users/entities/user.entity';
import { Video } from '../entities/video.entity';
import { VideoProcessor } from './video.processor';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video, Channel, User]),
    StorageModule,
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
  ],
  providers: [VideoProcessor],
})
export class VideoProcessingModule {}
