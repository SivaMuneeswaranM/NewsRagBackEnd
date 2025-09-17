interface Env { SESSIONS?: KVNamespace; SESSION_TTL_SECONDS?: string; }
const TTL = (env: Env) => Number(env.SESSION_TTL_SECONDS || "86400");
const key = (id: string) => `session:${id}:messages`;
const MEM: Map<string, string> = (globalThis as any).__mem ??= new Map();
const kvPut = async (env: Env, k: string, v: string) =>
  env.SESSIONS ? await env.SESSIONS.put(k, v, { expirationTtl: TTL(env) }) : MEM.set(k, v);

export const onRequestPost: PagesFunction<Env> = async ({ params, env }) => {
  const id = String(params.id);
  await kvPut(env, key(id), "[]");
  return Response.json({ ok: true });
};
