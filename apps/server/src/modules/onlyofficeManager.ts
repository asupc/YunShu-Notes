import fs from 'node:fs';
import http from 'node:http';
import { config } from '../config';

export type OnlyOfficeRuntimeState = 'ready' | 'starting' | 'stopped' | 'unavailable';

export interface OnlyOfficeStatusInfo {
  enabled: boolean;
  onDemand: boolean;
  state: OnlyOfficeRuntimeState;
  idleMinutes: number;
  message?: string;
}

interface DockerRequestResult {
  statusCode: number;
  body: string;
}

function dockerApiRequest(method: string, apiPath: string, timeoutMs = 15000): Promise<DockerRequestResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: config.onlyofficeDockerSocket,
        path: apiPath,
        method,
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode ?? 0, body: data });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('Docker Socket 请求超时'));
    });
    req.on('error', (err) => reject(err));
    req.end();
  });
}

class OnlyOfficeLifecycleManager {
  private lastActivityAt = 0;
  private startingAt = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private logger: { info: (msg: string) => void; warn: (msg: string) => void } = {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
  };

  setLogger(logger: { info: (msg: string) => void; warn: (msg: string) => void }): void {
    this.logger = logger;
  }

  private isDockerSocketReady(): boolean {
    if (!config.onlyofficeOnDemand) return false;
    try {
      return fs.existsSync(config.onlyofficeDockerSocket);
    } catch {
      return false;
    }
  }

  private getHealthCheckUrl(): string {
    if (config.onlyofficeHealthUrl) return config.onlyofficeHealthUrl;
    if (config.onlyofficeUrl) return `${config.onlyofficeUrl}/healthcheck`;
    return '';
  }

  async checkHealth(): Promise<boolean> {
    const url = this.getHealthCheckUrl();
    if (!url) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return false;
      const text = (await res.text()).trim().toLowerCase();
      return text === 'true' || text === 'ok' || res.status === 200;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async isContainerRunning(): Promise<'running' | 'stopped' | 'missing' | 'no_socket'> {
    if (!this.isDockerSocketReady()) return 'no_socket';
    try {
      const name = encodeURIComponent(config.onlyofficeContainerName);
      const res = await dockerApiRequest('GET', `/containers/${name}/json`, 5000);
      if (res.statusCode === 404) return 'missing';
      if (res.statusCode !== 200) return 'no_socket';
      const parsed = JSON.parse(res.body) as { State?: { Running?: boolean } };
      return parsed.State?.Running ? 'running' : 'stopped';
    } catch {
      return 'no_socket';
    }
  }

  markActivity(): void {
    this.lastActivityAt = Date.now();
  }

  async getStatus(): Promise<OnlyOfficeStatusInfo> {
    if (!config.onlyofficeUrl) {
      return {
        enabled: false,
        onDemand: false,
        state: 'unavailable',
        idleMinutes: config.onlyofficeIdleMinutes,
      };
    }

    const healthy = await this.checkHealth();
    if (healthy) {
      this.startingAt = 0;
      return {
        enabled: true,
        onDemand: config.onlyofficeOnDemand,
        state: 'ready',
        idleMinutes: config.onlyofficeIdleMinutes,
      };
    }

    if (!config.onlyofficeOnDemand) {
      return {
        enabled: true,
        onDemand: false,
        state: 'unavailable',
        idleMinutes: config.onlyofficeIdleMinutes,
        message: 'ONLYOFFICE 服务暂不可达，请检查容器是否已启动',
      };
    }

    const cState = await this.isContainerRunning();
    if (cState === 'running') {
      return {
        enabled: true,
        onDemand: true,
        state: 'starting',
        idleMinutes: config.onlyofficeIdleMinutes,
        message: 'ONLYOFFICE 引擎正在启动初始化，约需 20–40 秒...',
      };
    }
    if (cState === 'stopped') {
      return {
        enabled: true,
        onDemand: true,
        state: 'stopped',
        idleMinutes: config.onlyofficeIdleMinutes,
        message: 'ONLYOFFICE 当前处于休眠状态（0 内存占用），点击「在线编辑」将自动唤醒',
      };
    }
    if (cState === 'missing') {
      return {
        enabled: true,
        onDemand: true,
        state: 'unavailable',
        idleMinutes: config.onlyofficeIdleMinutes,
        message: `未找到 Docker 容器 ${config.onlyofficeContainerName}，请先使用 docker compose 创建该容器`,
      };
    }

    return {
      enabled: true,
      onDemand: true,
      state: 'unavailable',
      idleMinutes: config.onlyofficeIdleMinutes,
      message: `未检测到 Docker Socket（${config.onlyofficeDockerSocket}），无法自动唤醒 ONLYOFFICE 容器`,
    };
  }

  async wake(): Promise<OnlyOfficeStatusInfo> {
    this.markActivity();
    if (!config.onlyofficeUrl) {
      return {
        enabled: false,
        onDemand: false,
        state: 'unavailable',
        idleMinutes: config.onlyofficeIdleMinutes,
      };
    }

    if (await this.checkHealth()) {
      this.startingAt = 0;
      return {
        enabled: true,
        onDemand: config.onlyofficeOnDemand,
        state: 'ready',
        idleMinutes: config.onlyofficeIdleMinutes,
      };
    }

    if (!config.onlyofficeOnDemand) {
      return {
        enabled: true,
        onDemand: false,
        state: 'unavailable',
        idleMinutes: config.onlyofficeIdleMinutes,
        message: 'ONLYOFFICE 服务未启动（未开启按需自动启停）',
      };
    }

    if (!this.isDockerSocketReady()) {
      return {
        enabled: true,
        onDemand: true,
        state: 'unavailable',
        idleMinutes: config.onlyofficeIdleMinutes,
        message: `服务端未挂载 ${config.onlyofficeDockerSocket}，无法自动启动容器`,
      };
    }

    try {
      const name = encodeURIComponent(config.onlyofficeContainerName);
      const res = await dockerApiRequest('POST', `/containers/${name}/start`, 15000);
      if (res.statusCode === 204 || res.statusCode === 304) {
        if (!this.startingAt) this.startingAt = Date.now();
        this.logger.info(`[ONLYOFFICE] 已按需唤醒容器 ${config.onlyofficeContainerName}`);
        return {
          enabled: true,
          onDemand: true,
          state: 'starting',
          idleMinutes: config.onlyofficeIdleMinutes,
          message: '正在按需唤醒 ONLYOFFICE 引擎，约需 20–40 秒...',
        };
      }
      if (res.statusCode === 404) {
        return {
          enabled: true,
          onDemand: true,
          state: 'unavailable',
          idleMinutes: config.onlyofficeIdleMinutes,
          message: `未找到容器 ${config.onlyofficeContainerName}，请先运行 docker compose create onlyoffice`,
        };
      }
      return {
        enabled: true,
        onDemand: true,
        state: 'unavailable',
        idleMinutes: config.onlyofficeIdleMinutes,
        message: `启动 ONLYOFFICE 容器失败（Docker HTTP ${res.statusCode}）`,
      };
    } catch (err) {
      return {
        enabled: true,
        onDemand: true,
        state: 'unavailable',
        idleMinutes: config.onlyofficeIdleMinutes,
        message: err instanceof Error ? `唤醒容器失败：${err.message}` : '唤醒容器失败',
      };
    }
  }

  async stopIfIdle(): Promise<void> {
    if (!config.onlyofficeOnDemand || !this.isDockerSocketReady()) return;
    const idleMs = Math.max(1, config.onlyofficeIdleMinutes) * 60 * 1000;

    // 若刚刚唤醒尚在启动窗口内，不误停
    if (this.startingAt && Date.now() - this.startingAt < 3 * 60 * 1000) return;

    const cState = await this.isContainerRunning();
    if (cState !== 'running') return;

    // 服务重启后若容器碰巧在跑且一直无编辑活动，也按空闲策略自动休眠
    if (this.lastActivityAt === 0) {
      this.lastActivityAt = Date.now();
      return;
    }

    if (Date.now() - this.lastActivityAt < idleMs) return;

    try {
      const name = encodeURIComponent(config.onlyofficeContainerName);
      this.logger.info(
        `[ONLYOFFICE] 已空闲超过 ${config.onlyofficeIdleMinutes} 分钟，自动停止容器 ${config.onlyofficeContainerName} 释放内存`
      );
      await dockerApiRequest('POST', `/containers/${name}/stop?t=15`, 30000);
      this.startingAt = 0;
    } catch (err) {
      this.logger.warn(
        `[ONLYOFFICE] 自动停止空闲容器失败：${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  startIdleWatcher(): void {
    if (!config.onlyofficeOnDemand || this.idleTimer) return;
    this.idleTimer = setInterval(() => {
      void this.stopIfIdle();
    }, 60 * 1000);
    this.idleTimer.unref?.();
    this.logger.info(
      `[ONLYOFFICE] 已启用按需自动启停：容器 ${config.onlyofficeContainerName} 空闲 ${config.onlyofficeIdleMinutes} 分钟后自动休眠`
    );
  }
}

export const onlyofficeManager = new OnlyOfficeLifecycleManager();
