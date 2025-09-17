// frontend/functions/chat/stream.ts
interface Env {
  SESSIONS: KVNamespace;
  QDRANT_URL: string; QDRANT_API_KEY: string; QDRANT_COLLECTION: string;
  GEMINI_API_KEY: string; GEMINI_MODEL?: string;
  TOP_K_DEFAULT?: string; SESSION_TTL_SECONDS?: string;
}
type Msg = { role: "user" | "assistant"; content: string; ts: number };
const TTL = (env: Env) => Number(env.SESSION_TTL_SECONDS || "86400");
const kvKey = (id: string) => `session:${id}:messages`;

/* same optional server embed fallback as above */
let extractorPromise: Promise<any> | null = null;
async function serverEmbed(text: string, wasmBase: string): Promise<number[]> {
  const { pipeline, env } = await import("@xenova/transformers");
  if (!extractorPromise) {
    env.allowLocalModels = false; env.useBrowserCache = true; env.cacheDir = undefined;
    (env as any).backends ??= {}; (env as any).backends.onnx ??= { wasm: {} };
    (env as any).backends.onnx.wasm.wasmPaths = wasmBase;
    (env as any).backends.onnx.wasm.proxy = false;
    (env as any).backends.onnx.wasm.numThreads = 1;
    extractorPromise = pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { quantized: true });
  }
  const p = await extractorPromise;
  const out = await p(text, { pooling: "mean", normalize: true });
  return Array.from(out.data);
}

async function qdrantSearch(env: Env, vector: number[], limit: number) {
  const r = await fetch(`${env.QDRANT_URL}/collections/${env.QDRANT_COLLECTION}/points/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": env.QDRANT_API_KEY },
    body: JSON.stringify({ vector, limit, with_payload: true, score_threshold: 0 }),
  });
  if (!r.ok) throw new Error(`Qdrant search ${r.status}`);
  const j = await r.json();
  return (j.result ?? []).map((x: any) => x.payload);
}

function buildPrompt(q: string, ctxs: any[]) {
  const ctx = ctxs.map((c: any, i: number) =>
`[${i+1}] TITLE: ${c.title ?? "(untitled)"}\nURL: ${c.url ?? "(no url)"}\nPUBLISHED: ${c.publishedAt ?? c.date ?? ""}\nEXCERPT:\n${c.chunk ?? c.text ?? ""}`).join("\n\n");
  return `You are a helpful assistant. Answer using ONLY the provided news context.
Cite the article TITLE and URL when relevant. If the answer isn't present, say so briefly.

Question: ${q}

Context:
${ctx}

Stream the answer in short tokens.`;
}

async function stream(env: Env, sid: string, q: string, vec: number[] | undefined, wasmBase: string) {
  // save user
  const hist: Msg[] = JSON.parse((await env.SESSIONS.get(kvKey(sid))) ?? "[]");
  hist.push({ role: "user", content: q, ts: Date.now() });
  await env.SESSIONS.put(kvKey(sid), JSON.stringify(hist), { expirationTtl: TTL(env) });

  const vector = Array.isArray(vec) ? vec : await serverEmbed(q, wasmBase);
  const ctxs = await qdrantSearch(env, vector, Number(env.TOP_K_DEFAULT || "5"));
  const prompt = buildPrompt(q, ctxs);

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  let full = "";

  const write = (d: string) => writer.write(enc.encode(`data: ${d}\n\n`));
  const finish = async () => { await write(JSON.stringify({ done: true })); await writer.close(); };

  const model = env.GEMINI_MODEL || "gemini-1.5-flash";
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${env.GEMINI_API_KEY}`,
    { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }]}] }) }
  );

  if (res.ok && res.body) {
    const reader = res.body.getReader(); const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      const chunk = dec.decode(value, { stream: true });
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim(); if (!payload || payload === "[DONE]") continue;
        try {
          const obj = JSON.parse(payload);
          const parts = obj?.candidates?.[0]?.content?.parts ?? [];
          for (const p of parts) if (p?.text) { full += p.text; await write(p.text); }
        } catch {}
      }
    }
  } else {
    await write(JSON.stringify({ error: `Gemini ${res.status}` }));
  }

  // save assistant
  const after: Msg[] = JSON.parse((await env.SESSIONS.get(kvKey(sid))) ?? "[]");
  after.push({ role: "assistant", content: full || "[no output]", ts: Date.now() });
  await env.SESSIONS.put(kvKey(sid), JSON.stringify(after), { expirationTtl: TTL(env) });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const u = new URL(request.url);
  const sid = u.searchParams.get("session_id") || u.searchParams.get("sid") || "";
  const q   = u.searchParams.get("q") || "";
  const wasmBase = `${u.origin}/ort/`;
  if (!sid || !q) return new Response("Missing session_id or q", { status: 400 });
  return stream(env, sid, q, undefined, wasmBase);
};

// Optional POST for clients that want to send JSON (and can include vector)
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await request.json() as any;
  const sid  = body.session_id ?? body.sessionId ?? body.id;
  const q    = body.q ?? body.message;
  const vec  = body.vector as number[] | undefined;
  const wasmBase = `${new URL(request.url).origin}/ort/`;
  if (!sid || !q) return new Response("Missing session_id or q", { status: 400 });
  return stream(env, sid, q, vec, wasmBase);
};
