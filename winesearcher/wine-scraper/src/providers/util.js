class ProviderError extends Error {
  constructor(code, message, { retryable = false, retryAfterMs } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code; // NOT_CONFIGURED | NOT_IMPLEMENTED | TIMEOUT | RATE_LIMITED | MALFORMED | UPSTREAM
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promiseFactory, ms) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new ProviderError('TIMEOUT', `Timed out after ${ms} ms`, { retryable: true })), ms);
  });
  return Promise.race([promiseFactory(), timeout]).finally(() => clearTimeout(timer));
}

/** Retry only retryable errors, exponential backoff; honours a provider's retryAfterMs (rate limits). */
async function withRetry(fn, { retries = 2, baseMs = 200, timeoutMs = 15000 } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await withTimeout(fn, timeoutMs);
    } catch (e) {
      if (!(e instanceof ProviderError) || !e.retryable || attempt >= retries) throw e;
      await sleep(e.retryAfterMs ?? baseMs * 2 ** attempt);
      attempt++;
    }
  }
}

/** Run async tasks with a concurrency cap; results keep input order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

module.exports = { ProviderError, withRetry, withTimeout, mapLimit, sleep };
