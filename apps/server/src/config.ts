import 'dotenv/config';
import path from 'node:path';

const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(process.cwd(), 'data'));

export const config = {
  port: Number(process.env.PORT ?? 3001),
  wsPort: Number(process.env.WS_PORT ?? 3002),
  publicApiBase: (process.env.PUBLIC_API_BASE ?? 'http://127.0.0.1:3001').replace(/\/$/, ''),
  dataDir,
  sqlitePath: path.resolve(process.env.SQLITE_PATH ?? path.join(dataDir, 'yunshu.db')),
  filesDir: path.join(dataDir, 'files'),
  previewsDir: path.join(dataDir, 'previews'),
  jwtSecret: process.env.JWT_SECRET ?? 'yunshu-dev-jwt-secret-change-me',
  // 注册入口默认关闭；需要新增账号时临时设为 true 并重启容器
  allowRegistration: process.env.ALLOW_REGISTRATION === 'true',
  // ONLYOFFICE Docs 社区版配置（留空则关闭在线编辑，保留零依赖预览与本机 Office 唤起）
  onlyofficeUrl: (process.env.ONLYOFFICE_URL ?? '').replace(/\/+$/, ''),
  onlyofficeJwtSecret: process.env.ONLYOFFICE_JWT_SECRET ?? '',
  // ONLYOFFICE 容器回调云树服务端的内网地址（Docker 同网可填 http://yunshu-server:3001）
  onlyofficeInternalApiBase: (process.env.ONLYOFFICE_INTERNAL_API_BASE ?? '').replace(/\/+$/, ''),
  // 按需自动启停：平时容器停止不占内存，点击「在线编辑」自动唤醒，空闲超时自动停止
  onlyofficeOnDemand: process.env.ONLYOFFICE_ON_DEMAND === 'true',
  onlyofficeContainerName: process.env.ONLYOFFICE_CONTAINER_NAME ?? 'yunshu-onlyoffice',
  onlyofficeDockerSocket: process.env.ONLYOFFICE_DOCKER_SOCKET ?? '/var/run/docker.sock',
  onlyofficeHealthUrl: (process.env.ONLYOFFICE_HEALTH_URL ?? '').replace(/\/+$/, ''),
  onlyofficeIdleMinutes: Math.max(1, Number(process.env.ONLYOFFICE_IDLE_MINUTES ?? 15)),
  // ONLYOFFICE 容器自身的内网地址：保存回调里的 /cache/files 统一从这里取，
  // 避免文档服务器按公网 Host 生成 URL 时被 NAT 回环或前端 SPA 兜底影响。
  onlyofficeInternalUrl: (process.env.ONLYOFFICE_INTERNAL_URL ?? '').replace(/\/+$/, ''),
};
