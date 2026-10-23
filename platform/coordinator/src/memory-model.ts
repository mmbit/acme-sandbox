// The search model (memory.ts), on a thread of its own. onnxruntime-node loads a model and runs it synchronously on the
// thread that calls it, which would hold every HQ request up for the whole load and each batch. Messages in: an id and the texts, or a stop (memory.ts stopModel()). Out: the id and one vector per
// text, or why there are none.
import { parentPort, workerData } from 'node:worker_threads';

const { model, models } = workerData as { model: string; models: string };
const pipe = import('@huggingface/transformers').then(t => {
  Object.assign(t.env, { allowRemoteModels: false, localModelPath: models, cacheDir: models });
  // two threads: indexing runs next to the server, never instead of it
  return t.pipeline('feature-extraction', model, {
    dtype: 'q8',
    session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
  });
});
// A model that won't load is said once, with no id, and the thread ends: memory.ts then ranks by words only.
pipe.catch((err: unknown) => {
  parentPort!.postMessage({ failed: String(err) });
  parentPort!.close();
});

parentPort!.on('message', async ({ id, texts, stop }: { id: number; texts: string[]; stop?: true }) => {
  // (this thread's JavaScript runs only between two of the model's runs, so a stop here never cuts one off)
  if (stop) process.exit(0);
  try {
    const out = await (await pipe)(texts, { pooling: 'mean', normalize: true });
    const dim = out.dims[1],
      vectors = out.data as Float32Array;
    parentPort!.postMessage({ id, vectors: texts.map((_, i) => vectors.slice(i * dim, (i + 1) * dim)) });
  } catch (err) {
    parentPort!.postMessage({ id, error: String(err) });
  }
});
