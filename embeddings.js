// backend/src/embeddings.js
import { pipeline } from '@xenova/transformers';

let extractor = null;
let extractorPromise = null;

/** Start loading the model (called at server start) */
export async function initEmbeddings() {
  if (!extractorPromise) {
    extractorPromise = pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5')
      .then(p => {
        extractor = p;
        return p;
      })
      .catch(err => {
        extractorPromise = null; // allow retry on next call
        throw err;
      });
  }
  return extractorPromise;
}

/** True once the model is fully ready */
export function embeddingsReady() {
  return !!extractor;
}

/** Embed an array of texts (384-dim vectors) */
export async function embedTexts(texts) {
  if (!extractor) {
    // If not ready, wait for the loader (won't redownload if already cached)
    await initEmbeddings();
  }
  const out = [];
  for (const t of texts) {
    const emb = await extractor(t, { pooling: 'mean', normalize: true });
    out.push(Array.from(emb.data));
  }
  return out;
}
