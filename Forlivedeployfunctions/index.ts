// frontend/functions/session/index.ts
interface Env {
  SESSIONS?: KVNamespace;
  SESSION_TTL_SECONDS?: string;
}

const TTL = (env: Env) => Number(env.SESSION_TTL_SECONDS || "86400");
const kvKey = (id: string) => `session:${id}:messages`;

export const onRequestPost: PagesFunction<Env> = async ({ env }) => {
  const id = crypto.randomUUID();

  // Optional: initialize empty history in KV if bound
  if (env.SESSIONS) {
    await env.SESSIONS.put(kvKey(id), "[]", { expirationTtl: TTL(env) });
  }

  return Response.json({ sessionId: id, session_id: id }); // <-- UI needs this field
};
