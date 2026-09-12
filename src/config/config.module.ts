import { DynamicModule, Global, Module } from '@nestjs/common';
import { DAEMON_CONFIG, DaemonConfig, loadConfig } from './config.js';

@Global()
@Module({})
export class ConfigModule {
  /** Loads config from the environment, optionally overridden (used by tests). */
  static forRoot(overrides: Partial<DaemonConfig> = {}): DynamicModule {
    const config: DaemonConfig = { ...loadConfig(), ...overrides };
    return {
      module: ConfigModule,
      providers: [{ provide: DAEMON_CONFIG, useValue: config }],
      exports: [DAEMON_CONFIG],
    };
  }
}
