// GET /__diag?text=hello   -> returns small JSON if embedding works
let extractorReady: Promise<any> | null = null;
async function cfSafeEmbedInit() {
  if (!extractorReady) {
    const { pipeline, env } = await import("@xenova/transformers");
    env.allowLocalModels = false; env.useBrowserCache = true; env.cacheDir = undefined;
    // @ts-ignore
    env.backends ??= {}; env.backends.onnx ??= { wasm: {} };
    // @ts-ignore
    env.backends.onnx.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/";
    // @ts-ignore
    env.backends.onnx.wasm.proxy = false;
    // @ts-ignore
    env.backends.onnx.wasm.numThreads = 1;
    extractorReady = pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { quantized: true });
  }
  return extractorReady;
}
export const onRequestGet: PagesFunction = async ({ request }) => {
  try {
    const text = new URL(request.url).searchParams.get("text") || "hello world";
    const pipe = await cfSafeEmbedInit();
    const out = await pipe(text, { pooling: "mean", normalize: true });
    const arr = Array.from(out.data as Float32Array);
    return Response.json({ ok: true, dim: arr.length, sample: arr.slice(0, 8) });
  } catch (e: any) {
    return new Response(`diag error: ${e?.message || e}`, { status: 500 });
  }
};
