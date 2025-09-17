// frontend/functions/session/[id]/chat.ts

// ---------- Env & types ----------
interface Env {
  SESSIONS?: KVNamespace;

  // Qdrant
  QDRANT_URL: string;
  QDRANT_API_KEY?: string;
  QDRANT_COLLECTION: string;

  // Gemini
  GEMINI_API_KEY: string;
  GEMINI_MODEL?: string;        // default: gemini-1.5-flash
  GEMINI_EMBED_MODEL?: string;  // default: text-embedding-004 (768)

  // Retrieval tuning
  TOP_K_DEFAULT?: string;       // default: 5
  SESSION_TTL_SECONDS?: string; // default: 86400

  // Chip tuning
  MAX_SOURCES?: string;         // default: 3
  MIN_SCORE?: string;           // default: 0.35 (stricter than before)
  MIN_KW_OVERLAP?: string;      // default: 0.08 (8% of question tokens)
  W_SIM?: string;               // default: 0.7  (weight for vector score)
  W_KW?: string;                // default: 0.3  (weight for keyword overlap)

  // Optional allow-list of hosts (comma-separated). Example:
  // ALLOW_HOSTS=www.reuters.com,reuters.com,feeds.bbci.co.uk,www.bbc.com,apnews.com,theguardian.com,www.npr.org
  ALLOW_HOSTS?: string;
}

type Msg = { role: "user" | "assistant"; content: string; ts: number };

const TTL = (env: Env) => Number(env.SESSION_TTL_SECONDS || "86400");
const kvKey = (id: string) => `session:${id}:messages`;

const MEM: Map<string, string> = (globalThis as any).__mem ??= new Map();
const kvGet = async (env: Env, k: string) => (env.SESSIONS ? await env.SESSIONS.get(k) : MEM.get(k));
const kvPut = async (env: Env, k: string, v: string) =>
  (env.SESSIONS ? await env.SESSIONS.put(k, v, { expirationTtl: TTL(env) }) : MEM.set(k, v));

// ---------- Qdrant ----------
async function qdrantSearch(env: Env, vector: number[], limit: number) {
  const r = await fetch(`${env.QDRANT_URL}/collections/${env.QDRANT_COLLECTION}/points/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(env.QDRANT_API_KEY ? { "api-key": env.QDRANT_API_KEY } : {}),
    },
    body: JSON.stringify({
      vector,
      limit,
      with_payload: true,
      with_vector: false,
      score_threshold: 0,
    }),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`Qdrant search ${r.status}: ${body}`);
  const j = JSON.parse(body);

  const matches = (j.result ?? []) as Array<{
    id: string | number;
    score?: number;
    payload?: Record<string, any>;
  }>;

  return matches
    .map((m) => {
      const p = m.payload || {};
      const text = p.chunk ?? p.text ?? p.content ?? p.body ?? p.excerpt ?? "";
      const title = p.title ?? p.page_title ?? p.headline ?? null;
      const url = p.url ?? p.link ?? p.source ?? null;
      return {
        id: String(m.id),
        score: m.score ?? 0,
        text: String(text || ""),
        title: title ? String(title) : null,
        url: url ? String(url) : null,
      };
    })
    .filter((x) => x.text.trim().length > 0);
}

async function getQdrantDim(env: Env): Promise<number> {
  const r = await fetch(`${env.QDRANT_URL}/collections/${env.QDRANT_COLLECTION}`, {
    headers: { ...(env.QDRANT_API_KEY ? { "api-key": env.QDRANT_API_KEY } : {}) },
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`Qdrant get-collection ${r.status}: ${body}`);
  const j = JSON.parse(body);
  const size =
    j?.result?.config?.params?.vectors?.size ??
    j?.result?.config?.params?.vectors?.config?.size;
  if (!Number.isFinite(size)) throw new Error("Qdrant collection vector size not found");
  return Number(size);
}

// ---------- Gemini ----------
async function geminiEmbed(env: Env, text: string): Promise<number[]> {
  const model = env.GEMINI_EMBED_MODEL || "text-embedding-004";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${env.GEMINI_API_KEY}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: `models/${model}`,
      task_type: "RETRIEVAL_QUERY",
      content: { parts: [{ text }] },
      // output_dimensionality: 768,
    }),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`Gemini embed ${r.status}: ${body}`);
  const j = JSON.parse(body);
  const v = j?.embedding?.values;
  if (!Array.isArray(v)) throw new Error("No embedding in Gemini response");
  return v;
}

async function callGemini(env: Env, prompt: string) {
  const model = env.GEMINI_MODEL || "gemini-1.5-flash";
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] }),
    }
  );
  const body = await r.text();
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${body}`);
  const j = JSON.parse(body);
  const parts = j?.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p: any) => p.text || "").join("") ||
         "I couldn't find enough information in the ingested articles to answer.";
}

// ---------- Prompt ----------
function buildPrompt(
  question: string,
  ctxs: Array<{ text: string; title: string | null; url: string | null }>
) {
  const ctx = ctxs
    .map((c, i) => {
      const head: string[] = [];
      head.push(`[${i + 1}]`);
      if (c.title) head.push(`TITLE: ${c.title}`);
      if (c.url) head.push(`URL: ${c.url}`);
      return `${head.join("  ")}\nEXCERPT:\n${c.text}`;
    })
    .join("\n\n");

  return [
    "You are a helpful assistant. Use ONLY the provided context. If the context does not contain the answer, say that you don't have enough information.",
    "",
    `Question: ${question}`,
    "",
    "Context:",
    ctx || "(no context found)",
    "",
    "Answer in 3–7 concise sentences.",
  ].join("\n");
}

// ---------- Source filtering / reranking ----------
const STOP = new Set([
  "a","an","and","are","as","at","be","by","for","from","has","have","in","is","it",
  "of","on","or","that","the","to","was","were","will","with","about","into","than",
  "then","this","these","those","not","no","but","so","if","can","could","would","should"
]);

function tokenize(s: string): string[] {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(w => w && !STOP.has(w));
}

function kwOverlap(question: string, context: string): number {
  const q = tokenize(question);
  if (!q.length) return 0;
  const maxCheck = Math.min(q.length, 12); // cap to reduce bias from very long questions
  const ctx = new Set(tokenize(context));
  let hit = 0;
  for (let i = 0; i < maxCheck; i++) if (ctx.has(q[i])) hit++;
  return hit / maxCheck; // 0..1
}

function canonicalUrl(u?: string | null) {
  try {
    const x = new URL(String(u || ""));
    x.search = "";
    x.hash = "";
    // remove trailing slash for stable dedupe
    x.pathname = x.pathname.replace(/\/+$/, "");
    return x.toString();
  } catch {
    return null;
  }
}

function displayTitle(url: string, given?: string | null) {
  if (given && given.trim() && given.trim().toLowerCase() !== "reuters article") return given.trim();
  try {
    const u = new URL(url);
    const segs = u.pathname.split("/").filter(Boolean);
    const last = segs[segs.length - 1] || u.hostname;
    const clean = decodeURIComponent(last).replace(/[-_]+/g, " ");
    return clean.charAt(0).toUpperCase() + clean.slice(1);
  } catch {
    return "source";
  }
}

function pickSources(
  env: Env,
  question: string,
  matches: Array<{ url: string | null; title: string | null; score: number; text: string }>
) {
  const MAX_SOURCES = Number(env.MAX_SOURCES || "3");
  const MIN_SCORE = Number(env.MIN_SCORE || "0.35");
  const MIN_KW = Number(env.MIN_KW_OVERLAP || "0.08");
  const W_SIM = Number(env.W_SIM || "0.7");
  const W_KW = Number(env.W_KW || "0.3");

  // optional host allow-list
  const allow = (env.ALLOW_HOSTS || "")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  const allowSet = new Set(allow);

  // pre-filter + score
  type Cand = { url: string; title: string | null; text: string; score: number; kw: number; combined: number; host: string };
  const cands: Cand[] = [];

  for (const m of matches) {
    const u = canonicalUrl(m.url);
    if (!u) continue;

    // host allow-list if provided
    const host = (() => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } })();
    if (allowSet.size && !allowSet.has(host)) continue;

    if (typeof m.score === "number" && m.score < MIN_SCORE) continue;

    const kw = kwOverlap(question, m.text);
    if (kw < MIN_KW) continue;

    const combined = W_SIM * (m.score ?? 0) + W_KW * kw;

    cands.push({
      url: u,
      title: m.title,
      text: m.text,
      score: m.score ?? 0,
      kw,
      combined,
      host,
    });
  }

  // sort by combined score desc
  cands.sort((a, b) => b.combined - a.combined);

  // dedupe by canonical URL (one chip per article)
  const seen = new Set<string>();
  const picked = [];
  for (const c of cands) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    picked.push(c);
    if (picked.length >= MAX_SOURCES) break;
  }

  // fallback: if everything filtered out, keep the single best raw match
  if (picked.length === 0 && matches.length) {
    const m = matches[0];
    const u = canonicalUrl(m.url);
    if (u) {
      picked.push({
        url: u,
        title: m.title,
        text: m.text,
        score: m.score ?? 0,
        kw: kwOverlap(question, m.text),
        combined: m.score ?? 0,
        host: (() => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } })(),
      });
    }
  }

  // chips shown to UI
  const sources = picked.map(p => ({
    url: p.url,
    title: displayTitle(p.url, p.title),
  }));

  // contexts fed to LLM
  const filteredForPrompt = picked.map(p => ({
    text: p.text,
    title: displayTitle(p.url, p.title),
    url: p.url,
  }));

  return { sources, filteredForPrompt };
}

// ---------- Handler ----------
export const onRequestPost: PagesFunction<Env> = async ({ params, request, env }) => {
  try {
    const id = String(params.id || "");
    const { message } = (await request.json().catch(() => ({}))) as { message?: string };
    if (!message) return Response.json({ error: "Missing 'message'" }, { status: 400 });
    if (!env.GEMINI_API_KEY) return Response.json({ error: "GEMINI_API_KEY not set" }, { status: 500 });

    // 1) Load history
    let hist: Msg[] = [];
    try {
      const raw = await kvGet(env, kvKey(id));
      hist = raw ? (JSON.parse(raw) as Msg[]) : [];
    } catch { hist = []; }

    // 2) Save user message
    hist.push({ role: "user", content: message, ts: Date.now() });
    await kvPut(env, kvKey(id), JSON.stringify(hist));

    // 3) Embed (768) and verify dims
    const vec = await geminiEmbed(env, message);
    const expected = await getQdrantDim(env);
    if (vec.length !== expected) {
      return Response.json(
        { error: `Vector dims (${vec.length}) != Qdrant dims (${expected}) for collection ${env.QDRANT_COLLECTION}.` },
        { status: 400 }
      );
    }

    // 4) Retrieve
    const topK = Number(env.TOP_K_DEFAULT || "5");
    const matches = await qdrantSearch(env, vec, topK);

    if (matches.length === 0) {
      const msg = "I couldn't find any ingested articles to ground the answer. Please run the ingestion script and try again.";
      hist.push({ role: "assistant", content: msg, ts: Date.now() });
      await kvPut(env, kvKey(id), JSON.stringify(hist));
      return Response.json({ answer: msg, sources: [] });
    }

    // 5) Strict source picking (host allow-list + score + keyword)
    const { sources, filteredForPrompt } = pickSources(env, message, matches);

    // If filtering removed everything, keep top-1 for prompt to avoid refusal
    const promptContexts = filteredForPrompt.length ? filteredForPrompt : matches.slice(0, 1).map(m => ({
      text: m.text, title: m.title, url: m.url || null
    }));

    // 6) Build prompt & generate
    const prompt = buildPrompt(message, promptContexts);
    const answer = await callGemini(env, prompt);

    // 7) Save assistant reply
    hist.push({ role: "assistant", content: answer, ts: Date.now() });
    await kvPut(env, kvKey(id), JSON.stringify(hist));

    // 8) Return compact, relevant sources
    return Response.json({ answer, sources });
  } catch (e: any) {
    return Response.json({ error: e?.message || String(e) }, { status: 500 });
  }
};
