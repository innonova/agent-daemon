import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { DaemonConfig } from './config/config.js';
import { GatewayModule } from './gateway/gateway.module.js';
import { HealthController } from './health.controller.js';
import { ProfilesModule } from './profiles/profiles.module.js';
import { SessionsModule } from './sessions/sessions.module.js';

@Module({})
export class AppModule {
  static forRoot(overrides: Partial<DaemonConfig> = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(overrides),
        ProfilesModule,
        SessionsModule,
        GatewayModule,
      ],
      controllers: [HealthController],
    };
  }
}
