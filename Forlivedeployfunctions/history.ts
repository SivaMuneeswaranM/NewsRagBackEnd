interface Env { SESSIONS?: KVNamespace; }
const key = (id: string) => `session:${id}:messages`;
const MEM: Map<string, string> = (globalThis as any).__mem ??= new Map();
const kvGet = async (env: Env, k: string) =>
  env.SESSIONS ? await env.SESSIONS.get(k) : MEM.get(k);

export const onRequestGet: PagesFunction<Env> = async ({ params, env }) => {
  const id = String(params.id);
  const data = await kvGet(env, key(id));
  return Response.json({ messages: JSON.parse(data ?? "[]") });
};
