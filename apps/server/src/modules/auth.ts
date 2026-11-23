import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../db';

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, key] = stored.split(':');
  if (!salt || !key) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const keyBuf = Buffer.from(key, 'hex');
  if (derived.length !== keyBuf.length) return false;
  return crypto.timingSafeEqual(derived, keyBuf);
}

export interface AuthPayload {
  userId: string;
  email: string;
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<AuthPayload | undefined> {
  try {
    return await req.jwtVerify<AuthPayload>();
  } catch {
    reply.code(401).send({ error: '未登录或登录已过期，请重新登录' });
    return undefined;
  }
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash?: string;
  created_at: string;
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const registerSchema = z.object({
    email: z.string().email('请输入有效的邮箱地址'),
    password: z.string().min(6, '密码至少需要 6 位'),
    displayName: z.string().min(1).max(40).optional(),
  });

  app.post('/api/v1/auth/register', async (req, reply) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? '参数错误' });
    }
    const { email, password, displayName } = parsed.data;
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      return reply.code(409).send({ error: '该邮箱已注册' });
    }

    const id = crypto.randomUUID();
    const name = displayName ?? email.split('@')[0];
    const passwordHash = hashPassword(password);
    db.prepare('INSERT INTO users (id, email, display_name, password_hash) VALUES (?, ?, ?, ?)').run(
      id,
      email,
      name,
      passwordHash
    );
    const user = db
      .prepare('SELECT id, email, display_name, created_at FROM users WHERE id = ?')
      .get(id) as UserRow;

    const token = app.jwt.sign({ userId: user.id, email: user.email }, { expiresIn: '7d' });
    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        createdAt: user.created_at,
      },
    };
  });

  const loginSchema = z.object({
    email: z.string().email(),
    password: z.string().min(1),
  });

  app.post('/api/v1/auth/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '请输入正确的邮箱和密码' });
    }
    const { email, password } = parsed.data;
    const user = db
      .prepare('SELECT id, email, display_name, password_hash, created_at FROM users WHERE email = ?')
      .get(email) as UserRow | undefined;

    if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
      return reply.code(401).send({ error: '邮箱或密码不正确' });
    }

    const token = app.jwt.sign({ userId: user.id, email: user.email }, { expiresIn: '7d' });
    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        createdAt: user.created_at,
      },
    };
  });

  app.get('/api/v1/auth/me', async (req, reply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return;
    const user = db
      .prepare('SELECT id, email, display_name, created_at FROM users WHERE id = ?')
      .get(auth.userId) as UserRow | undefined;
    if (!user) return reply.code(404).send({ error: '用户不存在' });
    return {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      createdAt: user.created_at,
    };
  });
}
