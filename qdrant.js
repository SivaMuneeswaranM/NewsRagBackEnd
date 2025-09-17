// backend/src/qdrant.js (REST-based, no SDK mismatch)
import axios from 'axios';
import { config } from './config.js';

const client = axios.create({
  baseURL: config.qdrantUrl.replace(/\/+$/, ''), // trim trailing slash
  headers: config.qdrantApiKey ? { 'api-key': config.qdrantApiKey } : {},
  timeout: 30000,
});

// Ensure collection exists (create if missing)
export async function ensureCollection(vectorSize) {
  const name = config.qdrantCollection;

  try {
    await client.get(`/collections/${encodeURIComponent(name)}`);
    return;
  } catch (e) {
    if (!(e.response && e.response.status === 404)) throw e;
  }

  // Create with Cosine distance
  await client.put(`/collections/${encodeURIComponent(name)}`, {
    vectors: { size: vectorSize, distance: 'Cosine' },
  });
}

// Upsert points
export async function upsertPoints(points) {
  const name = config.qdrantCollection;
  await client.put(`/collections/${encodeURIComponent(name)}/points?wait=true`, {
    points,
  });
}

// Search top-k
export async function searchTopK(vector, topK = 5, filter = undefined) {
  const name = config.qdrantCollection;
  const { data } = await client.post(
    `/collections/${encodeURIComponent(name)}/points/search`,
    {
      vector,
      limit: topK,
      with_payload: true,
      score_threshold: 0.0,
      filter,
    }
  );
  return data.result || [];
}
