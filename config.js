import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: process.env.PORT || 4000,

  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  sessionTTL: parseInt(process.env.SESSION_TTL_SECONDS || '86400', 10),
  maxHistory: parseInt(process.env.MAX_HISTORY || '50', 10),

  qdrantUrl: process.env.QDRANT_URL || 'http://localhost:6333',
  qdrantApiKey: process.env.QDRANT_API_KEY || '',
  qdrantCollection: process.env.QDRANT_COLLECTION || 'news',

  jinaApiKey: process.env.JINA_API_KEY || '',
  jinaModel: process.env.JINA_EMBED_MODEL || 'jina-embeddings-v3',
  chunkSize: parseInt(process.env.CHUNK_SIZE || '1200', 10),
  chunkOverlap: parseInt(process.env.CHUNK_OVERLAP || '150', 10),

  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
  topKDefault: parseInt(process.env.TOP_K_DEFAULT || '5', 10),
};
