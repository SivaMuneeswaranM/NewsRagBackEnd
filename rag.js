// backend/src/rag.js (ESM)
import { randomUUID } from 'crypto';
import { embedTexts } from './embeddings.js';
import { ensureCollection, upsertPoints, searchTopK } from './qdrant.js';

export function chunkText(text, size = 800, overlap = 120) {
  const out = [];
  for (let i = 0; i < text.length; i += (size - overlap)) {
    out.push(text.slice(i, i + size));
    if (i + size >= text.length) break;
  }
  return out;
}

export async function indexDocuments(docs) {
  if (!docs?.length) return { inserted: 0 };

  // Make sure collection exists with the right vector size
  const [probe] = await embedTexts(['probe']);
  await ensureCollection(probe.length);

  let inserted = 0;
  const BATCH = 16;

  for (const doc of docs) {
    const chunks = chunkText(doc.text);
    for (let i = 0; i < chunks.length; i += BATCH) {
      const slice = chunks.slice(i, i + BATCH);
      const vecs = await embedTexts(slice);
      const points = vecs.map((v, j) => ({
        id: randomUUID(),                 // valid UUID per chunk
        vector: v,
        payload: {
          title: doc.title,
          url: doc.url,
          text: slice[j],
          publishedAt: doc.publishedAt
        }
      }));
      await upsertPoints(points);
      inserted += points.length;
    }
  }
  return { inserted };
}

export async function retrieve(query, k = 5) {
  const [qv] = await embedTexts([query]);
  return await searchTopK(qv, k);
}

// (optional) If you want to import buildPrompt in server.js:
export function buildPrompt(question, context) {
  return `
You are a helpful assistant answering questions strictly using the provided Reuters context.
Cite relevant titles and URLs when answering.

Question: ${question}

Context:
${context}

Answer in 4–7 concise sentences and include 1–3 source titles with URLs.
`.trim();
}
