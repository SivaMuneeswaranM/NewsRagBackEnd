export const onRequestGet: PagesFunction = async ({ env }) =>
  Response.json({ QDRANT_COLLECTION: env.QDRANT_COLLECTION });
