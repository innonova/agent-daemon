import { Module } from '@nestjs/common';
import { ProfilesModule } from '../profiles/profiles.module.js';
import { SessionsService } from './sessions.service.js';

@Module({
  imports: [ProfilesModule],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
