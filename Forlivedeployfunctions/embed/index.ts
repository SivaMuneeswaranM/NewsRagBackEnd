// functions/embed/index.ts
export interface Env {
  GEMINI_API_KEY: string;
  GEMINI_EMBED_MODEL?: string; // default: text-embedding-004
  LLM_RETRY_MAX?: string;
}

type MaybeJson = string | string[] | { input?: any; texts?: any };

function json(data: any, status = 200, headers: Record<string,string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "x-embed-handler": "v3-batch", ...headers },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function normalizeInputs(body: MaybeJson | FormDataEntryValue | null): string[] {
  if (body == null) return [];
  if (typeof (body as any)?.text === "function" && (body as any).name) return []; // File not supported
  if (typeof body === "string") return [body];
  if (Array.isArray(body)) return body.map(String);
  if (typeof body === "object") {
    const obj = body as any;
    if (Array.isArray(obj.input)) return obj.input.map(String);
    if (typeof obj.input === "string") return [obj.input];
    if (Array.isArray(obj.texts)) return obj.texts.map(String);
    if (typeof obj.texts === "string") return [obj.texts];
  }
  return [];
}

// Quick GET to verify which handler is live
export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  return json({
    ok: true,
    handler: "embed-v3-batch",
    model: env.GEMINI_EMBED_MODEL || "text-embedding-004",
  });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  try {
    if (!env.GEMINI_API_KEY) return json({ error: "Missing GEMINI_API_KEY" }, 500);

    // ---------- tolerant body parsing ----------
    const ct = request.headers.get("content-type") || "";
    let inputs: string[] = [];
    if (ct.includes("application/json")) {
      const body = (await request.json().catch(() => null)) as MaybeJson | null;
      inputs = normalizeInputs(body);
    } else if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
      const fd = await request.formData();
      const raw = fd.get("input") ?? fd.get("texts");
      inputs = normalizeInputs(raw as any);
    } else {
      const raw = await request.text();
      let parsed: any = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch {}
      inputs = normalizeInputs(parsed ?? raw);
    }

    inputs = inputs.map((s) => String(s).trim()).filter((s) => s.length > 0);
    if (!inputs.length) {
      return json(
        { error: "Provide non-empty input as {input: string|string[]} (or raw string/array/form 'input'/'texts')." },
        400
      );
    }

    // ---------- ALWAYS use batch endpoint ----------
    const modelId = env.GEMINI_EMBED_MODEL || "text-embedding-004";
    const modelPath = `models/${modelId}`;
    const url = `https://generativelanguage.googleapis.com/v1beta/${modelPath}:batchEmbedContents?key=${env.GEMINI_API_KEY}`;

    const payload = {
      requests: inputs.map((text) => ({
        model: modelPath, // keep explicit in each request (API is picky)
        content: { parts: [{ text }] },
      })),
    };

    // ---------- call with retry/backoff ----------
    const max = Number(env.LLM_RETRY_MAX) || 4;
    let lastErr = "";
    for (let attempt = 0; attempt <= max; attempt++) {
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const txt = await resp.clone().text();

        if (!resp.ok) {
          if ([429, 500, 502, 503, 504].includes(resp.status) && attempt < max) {
            await sleep(300 * Math.pow(2, attempt) + Math.floor(Math.random() * 150));
            continue;
          }
          return json({ error: `Upstream embed ${resp.status}`, detail: txt }, 502);
        }

        const data = JSON.parse(txt);
        const vectors =
          (data.embeddings?.map((e: any) => e.values)) ||
          (data.responses?.map((r: any) => r.embedding?.values)) ||
          [];
        return json({ vectors });
      } catch (e: any) {
        lastErr = String(e?.message || e);
        if (/timeout|network|fetch/i.test(lastErr) && attempt < max) {
          await sleep(300 * Math.pow(2, attempt) + Math.floor(Math.random() * 150));
          continue;
        }
        break;
      }
    }

    return json({ error: lastErr || "Embed failed" }, 500);
  } catch (e: any) {
    return json({ error: e?.message || "Embed failed" }, 500);
  }
};
