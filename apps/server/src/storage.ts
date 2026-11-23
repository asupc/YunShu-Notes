import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config';

/**
 * 校验并解析本地安全文件路径，防止路径穿越
 */
export function resolveStoragePath(storageKey: string): string {
  const safeRel = storageKey.replace(/^\/+/, '');
  const full = path.resolve(config.dataDir, safeRel);
  if (!full.startsWith(config.dataDir)) {
    throw new Error('非法存储路径');
  }
  return full;
}

export async function writeStorageFile(storageKey: string, data: Buffer): Promise<void> {
  const full = resolveStoragePath(storageKey);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, data);
}

export async function readStorageFile(storageKey: string): Promise<Buffer> {
  const full = resolveStoragePath(storageKey);
  return fs.readFile(full);
}

/**
 * 生成短时 HMAC 签名 URL，保持与 S3 预签名接口完全一致的客户端体验
 */
export function signStorageToken(storageKey: string, mode: 'put' | 'get', expiresInSec = 900): string {
  const exp = Math.floor(Date.now() / 1000) + expiresInSec;
  const payload = `${mode}:${storageKey}:${exp}`;
  const sig = crypto.createHmac('sha256', config.jwtSecret).update(payload).digest('hex');
  return `${exp}.${sig}`;
}

export function verifyStorageToken(storageKey: string, mode: 'put' | 'get', token: string): boolean {
  const [expStr, sig] = token.split('.');
  if (!expStr || !sig) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = crypto
    .createHmac('sha256', config.jwtSecret)
    .update(`${mode}:${storageKey}:${exp}`)
    .digest('hex');
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

export function buildSignedUploadUrl(storageKey: string, baseUrl: string = config.publicApiBase): string {
  const token = signStorageToken(storageKey, 'put', 600);
  const encoded = encodeURIComponent(storageKey);
  return `${baseUrl.replace(/\/$/, '')}/api/v1/files/blob?key=${encoded}&token=${token}`;
}

export function buildSignedDownloadUrl(storageKey: string, baseUrl: string = config.publicApiBase): string {
  const token = signStorageToken(storageKey, 'get', 900);
  const encoded = encodeURIComponent(storageKey);
  return `${baseUrl.replace(/\/$/, '')}/api/v1/files/blob?key=${encoded}&token=${token}`;
}
