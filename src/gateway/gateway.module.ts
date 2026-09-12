import { Module } from '@nestjs/common';
import { ProfilesModule } from '../profiles/profiles.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { AgentGateway } from './agent.gateway.js';

@Module({
  imports: [ProfilesModule, SessionsModule],
  providers: [AgentGateway],
})
export class GatewayModule {}
