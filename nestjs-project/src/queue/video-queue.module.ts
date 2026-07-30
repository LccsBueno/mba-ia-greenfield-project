import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { VIDEO_PROCESSING_QUEUE } from './queue.constants';
import { VideoQueueService } from './video-queue.service';

@Module({
  imports: [BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })],
  providers: [VideoQueueService],
  exports: [VideoQueueService],
})
export class VideoQueueModule {}
