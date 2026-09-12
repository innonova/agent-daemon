import { Module } from '@nestjs/common';
import { ProfilesService } from './profiles.service.js';

@Module({
  providers: [ProfilesService],
  exports: [ProfilesService],
})
export class ProfilesModule {}
