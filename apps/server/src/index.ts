import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { config } from './config';
import './db';
import { type AuthPayload, registerAuthRoutes } from './modules/auth';
import { registerNodeRoutes } from './modules/nodes';
import { registerFileRoutes } from './modules/files';
import { registerMigrationRoutes } from './modules/migration';
import { registerOnlyOfficeRoutes } from './modules/onlyoffice';
import { startHocuspocusServer } from './ws/hocuspocus';

async function bootstrap(): Promise<void> {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(jwt, { secret: config.jwtSecret });

  app.get('/api/health', async () => ({
    status: 'ok',
    service: 'yunshu-server',
    storage: 'sqlite+local-disk',
  }));

  await registerAuthRoutes(app);
  await registerNodeRoutes(app);
  await registerFileRoutes(app);
  await registerMigrationRoutes(app);
  await registerOnlyOfficeRoutes(app);

  startHocuspocusServer((token) => {
    try {
      return app.jwt.verify<AuthPayload>(token);
    } catch {
      return null;
    }
  });

  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(`云树笔记 SQLite 服务端已启动：http://0.0.0.0:${config.port}（数据库：${config.sqlitePath}）`);
}

void bootstrap();
