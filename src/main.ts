import { INestApplication, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module.js';
import { DAEMON_CONFIG, DaemonConfig } from './config/config.js';
import { messageParser } from './gateway/agent.gateway.js';
import { ProfilesService } from './profiles/profiles.service.js';
import { SessionsService } from './sessions/sessions.service.js';

/** Builds the application; shared by the real entry point and the e2e tests. */
export async function createApp(
  overrides: Partial<DaemonConfig> = {},
  options: { quiet?: boolean } = {},
): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(overrides), {
    logger: options.quiet ? false : ['log', 'warn', 'error'],
  });
  app.useWebSocketAdapter(new WsAdapter(app, { messageParser }));
  // Deliberately no enableShutdownHooks(): Nest would treat SIGHUP, our
  // reload signal, as a shutdown. Signals are handled explicitly below.
  return app;
}

async function bootstrap(): Promise<void> {
  const app = await createApp();
  const config = app.get<DaemonConfig>(DAEMON_CONFIG);
  const logger = new Logger('main');

  // Staying up matters more than a clean stack: a bug in one request must
  // not end every session on the machine.
  process.on('uncaughtException', (err) =>
    logger.error(`uncaught exception: ${err.stack ?? err}`),
  );
  process.on('unhandledRejection', (err) =>
    logger.error(`unhandled rejection: ${(err as Error)?.stack ?? err}`),
  );

  process.on('SIGHUP', () => {
    logger.log('SIGHUP received, reloading profiles');
    app
      .get(ProfilesService)
      .reload()
      .catch((err: Error) =>
        logger.error(`profile reload failed: ${err.message}`),
      );
  });

  let shuttingDown = false;
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.log(`${sig} received, shutting down`);
      // Whatever happens below, the process ends.
      setTimeout(() => process.exit(0), 15_000).unref();
      void app
        .get(SessionsService)
        .terminateAll()
        .then(() => {
          // app.close() waits for open connections; websockets never end on
          // their own, so drop them first.
          const server = app.getHttpServer() as {
            closeAllConnections?: () => void;
          };
          server.closeAllConnections?.();
          return app.close();
        })
        .catch((err: Error) => logger.error(`shutdown error: ${err.message}`))
        .finally(() => process.exit(0));
    });
  }

  await app.listen(config.port, config.host);
  const address = app.getHttpServer().address() as {
    address: string;
    port: number;
  };
  logger.log(
    `agent-daemon listening on ws://${address.address}:${address.port}/`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  await bootstrap();
}
