// Tiny promise pool (zero dependencies). Runs `worker(item, index)` over `items` with at most
// `concurrency` calls in flight, preserving input order in the results. Used by the site probes,
// the sitemap discovery and (later) the crawler so a slow host never fans out into hundreds of
// simultaneous sockets.

/**
 * @template T, R
 * @param {Iterable<T>} items
 * @param {(item: T, index: number) => Promise<R>|R} worker
 * @param {number} [concurrency=4]
 * @returns {Promise<R[]>} results in input order; rejects with the first error after the lanes drain
 */
export async function runPool(items, worker, concurrency = 4) {
  const list = Array.from(items || []);
  const results = new Array(list.length);
  if (!list.length) return results;
  const lanes = Math.max(1, Math.min(Math.floor(Number(concurrency)) || 1, list.length));
  let next = 0;
  let firstError = null;
  async function lane() {
    while (next < list.length && !firstError) {
      const i = next++;
      try { results[i] = await worker(list[i], i); }
      catch (e) { if (!firstError) firstError = e; }
    }
  }
  await Promise.all(Array.from({ length: lanes }, lane));
  if (firstError) throw firstError;
  return results;
}

/**
 * Like runPool but never rejects: each slot is { status: 'fulfilled', value } or { status: 'rejected', reason }.
 */
export function runPoolSettled(items, worker, concurrency = 4) {
  return runPool(items, async (item, i) => {
    try { return { status: 'fulfilled', value: await worker(item, i) }; }
    catch (e) { return { status: 'rejected', reason: e }; }
  }, concurrency);
}
