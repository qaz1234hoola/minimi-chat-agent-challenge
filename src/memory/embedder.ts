import path from "node:path";
import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

// Store downloaded ONNX weights locally inside the project folder
env.cacheDir = path.resolve(process.cwd(), ".cache");

const MODEL_ID = "nomic-ai/nomic-embed-text-v1.5";
let extractor: FeatureExtractionPipeline | null = null;

/**
 * Warms up the local ONNX embedder at server startup so the first user query
 * incurs zero model-loading latency.
 */
export async function initEmbedder(): Promise<void> {
  if (extractor) return;
  console.log(`[Embedder] Loading ${MODEL_ID} (q8 quantized)...`);
  const start = Date.now();

  extractor = await pipeline("feature-extraction", MODEL_ID, {
    dtype: "q8",
  });

  console.log(`[Embedder] Ready in ${((Date.now() - start) / 1000).toFixed(2)}s`);
}

/**
 * Generates a normalized 768-dim Float32Array embedding with Nomic task prefixes.
 */
export async function embedText(
  text: string,
  task: "search_document" | "search_query"
): Promise<Float32Array> {
  if (!extractor) {
    await initEmbedder();
  }

  const prefixed = `${task}: ${text}`;
  const output = await extractor!(prefixed, {
    pooling: "mean",
    normalize: true,
  });

  // Convert Tensor data into a contiguous 32-bit float binary buffer for sqlite-vec
  return new Float32Array(output.data as Float32Array);
}