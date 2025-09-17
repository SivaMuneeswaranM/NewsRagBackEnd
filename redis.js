import Redis from 'ioredis';
import { config } from './config.js';
import { logger } from './logger.js';

export const redis = new Redis(config.redisUrl);

redis.on('connect', () => logger.info('Redis connected'));
redis.on('error', (err) => logger.error('Redis error: ' + err));

const key = (sessionId) => `session:${sessionId}:messages`;

export async function createSession(sessionId) {
  // prime empty list with TTL
  await redis.del(key(sessionId));
  await redis.expire(key(sessionId), config.sessionTTL);
}

export async function appendMessage(sessionId, role, content) {
  const msg = JSON.stringify({ role, content, ts: Date.now() });
  await redis.rpush(key(sessionId), msg);
  await redis.ltrim(key(sessionId), -config.maxHistory, -1);
  await redis.expire(key(sessionId), config.sessionTTL);
}

export async function getHistory(sessionId) {
  const arr = await redis.lrange(key(sessionId), 0, -1);
  return arr.map((s) => JSON.parse(s));
}

export async function clearSession(sessionId) {
  await redis.del(key(sessionId));
}
