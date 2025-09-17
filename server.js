import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient as createRedisClient } from 'redis';
import { retrieve } from './rag.js';


const PORT         = parseInt(process.env.PORT || '4000', 10);
const TOP_K        = parseInt(process.env.TOP_K_DEFAULT || '5', 10);
const GEMINI_KEY   = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const USE_REDIS    = !!process.env.REDIS_URL;

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const genAI = GEMINI_KEY ? new GoogleGenerativeAI(GEMINI_KEY) : null;

const CLEAN_MAX = 1700;

function clean(s, max = CLEAN_MAX) {
  const t = (s ?? '').toString().replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}
function toPlain(val) {
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) return val.map(toPlain).join(' ');
  if (val && typeof val === 'object') {
    const pref = ['text', 'articleBody', 'content', 'body', 'summary', 'paragraph', 'title', 'url'];
    for (const k of pref) if (typeof val[k] === 'string') return val[k];
    // otherwise all string fields
    return Object.values(val).filter(v => typeof v === 'string').join(' ');
  }
  return '';
}
function dedupeByUrl(hits, limit = 5) {
  const seen = new Set();
  const out = [];
  for (const h of hits || []) {
    const raw = toPlain(h?.payload?.url) || '';
    const key = raw.split('?')[0];
    if (!key) continue;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(h);
      if (out.length >= limit) break;
    }
  }
  return out;
}
function blockFor(h, maxTxt = 900) {
  const title = clean(toPlain(h?.payload?.title), 200);
  const url   = clean(toPlain(h?.payload?.url),   600);
  const text  = clean(toPlain(h?.payload?.text),  maxTxt);
  return `# ${title}\nURL: ${url}\n${text}`;
}
function pickSources(uniqueHits, k = 3) {
  return uniqueHits.slice(0, k).map(h => ({
    title: toPlain(h?.payload?.title) || 'Source',
    url:   toPlain(h?.payload?.url)   || ''
  }));
}


const memoryStore = new Map(); // sessionId -> { messages: [...] }

let redis = null;
if (USE_REDIS) {
  redis = createRedisClient({ url: process.env.REDIS_URL });
  redis.on('error', (err) => console.error('[redis] error:', err?.message));
  try {
    await redis.connect();
    console.log('[redis] connected');
  } catch (e) {
    console.warn('[redis] failed, falling back to memory:', e?.message);
    redis = null;
  }
}

const keyFor = (sid) => `newsrag:session:${sid}`;

async function getHistory(sessionId) {
  if (redis) {
    const raw = await redis.get(keyFor(sessionId));
    if (!raw) return [];
    try { return JSON.parse(raw); } catch { return []; }
  }
  return memoryStore.get(sessionId)?.messages || [];
}
async function setHistory(sessionId, messages) {
  if (redis) {
    await redis.set(keyFor(sessionId), JSON.stringify(messages), { EX: parseInt(process.env.SESSION_TTL_SECONDS || '86400', 10) });
    return;
  }
  memoryStore.set(sessionId, { messages });
}
async function appendHistory(sessionId, entry) {
  const hist = await getHistory(sessionId);
  hist.push(entry);
  await setHistory(sessionId, hist);
}
async function clearHistory(sessionId) {
  if (redis) {
    await redis.del(keyFor(sessionId));
    return;
  }
  memoryStore.delete(sessionId);
}


app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/debug', async (_req, res) => {
  const sampleSession = [...memoryStore.keys()][0] || null;
  res.json({
    ok: true,
    geminiEnabled: !!genAI,
    model: GEMINI_MODEL,
    topK: TOP_K,
    redis: !!redis,
    sampleSession
  });
});


app.post('/session', async (_req, res) => {
  const sessionId = randomUUID();
  await setHistory(sessionId, []);
  res.json({ sessionId });
});

app.get('/session/:id/history', async (req, res) => {
  const messages = await getHistory(req.params.id);
  res.json({ sessionId: req.params.id, messages });
});

app.post('/session/:id/clear', async (req, res) => {
  await clearHistory(req.params.id);
  res.json({ ok: true });
});


app.post('/session/:id/chat', async (req, res) => {
  try {
    const sessionId = req.params.id;
    const message   = (req.body?.message ?? '').toString().trim();
    const k         = Math.max(3, Math.min(10, parseInt(req.body?.topK || TOP_K, 10)));

    if (!message) return res.status(400).json({ error: 'message is required' });

    // ensure session exists
    const hist = await getHistory(sessionId);
    if (!hist.length) await setHistory(sessionId, []);

    // record user message
    await appendHistory(sessionId, { role: 'user', content: message, ts: Date.now() });

    // 1) retrieve
    const rawHits = await retrieve(message, k);
    const hits    = dedupeByUrl(rawHits, 5);

    if (!hits.length) {
      const answer = "I couldn't find anything relevant in the indexed Reuters articles.";
      await appendHistory(sessionId, { role: 'assistant', content: answer, ts: Date.now() });
      return res.json({ answer, sources: [] });
    }

    
    const blocks = [];
    let total = 0;
    for (const h of hits) {
      const b = blockFor(h, 700);
      total += b.length;
      if (total > 6000) break;      // keep under a safe prompt size
      blocks.push(b);
    }
    const context = blocks.join('\n\n');
    const sources = pickSources(hits, 3);

    
    let answer;
    if (!genAI) {
      // fallback: a short readable summary with sources (not raw “Top passages”)
      answer =
        `Here is a brief extract from the most relevant Reuters pieces for: "${message}".\n\n` +
        blocks.slice(0, 2).join('\n\n') +
        `\n\nSources:\n` +
        sources.map(s => `• ${s.title} — ${s.url}`).join('\n');
    } else {
      const prompt = `
You are a precise assistant. Answer the user's question using ONLY the context below.
If the context is insufficient, say so briefly. Do not invent details.

Write 4–7 concise sentences. Include 1–3 inline citations in parentheses with very short titles.
Then add a "Sources:" list with the provided URLs (1–3).

Question: ${message}

Context:
${context}
`.trim();

      const model  = genAI.getGenerativeModel({ model: GEMINI_MODEL });
      const result = await model.generateContent(prompt);
      answer = result?.response?.text?.() || 'No answer.';
    }

    // 4) append assistant message to history
    await appendHistory(sessionId, { role: 'assistant', content: answer, ts: Date.now(), sources });

    // 5) respond
    res.json({ answer, sources });
  } catch (e) {
    console.error('chat error:', e?.response?.status, e?.response?.data || e.message);

    // graceful fallback even on error
    const fallback = 'I hit an issue generating a full answer. Please try again in a moment.';
    res.status(200).json({ answer: fallback, sources: [] });
  }
});

app.listen(PORT, () => {
  console.log(`API on http://localhost:${PORT}`);
});
