'use strict';

function jitterDelay(attempt, opts = {}) {
  const baseDelayMs = opts.baseDelayMs ?? 250;
  const maxDelayMs = opts.maxDelayMs ?? 30000;
  const random = opts.random ?? Math.random;
  const exponential = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
  return Math.floor(random() * exponential);
}

function sleep(ms, timer = setTimeout) {
  return new Promise((resolve) => timer(resolve, ms));
}

async function withRetries(fn, opts = {}) {
  const maxRetries = opts.maxRetries ?? 8;
  const baseDelayMs = opts.baseDelayMs ?? 250;
  const maxDelayMs = opts.maxDelayMs ?? 30000;
  const random = opts.random ?? Math.random;
  const sleeper = opts.sleeper ?? sleep;
  const onFinalFailure = opts.onFinalFailure;
  const payloads = opts.payloads ?? [];

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn(attempt);
      return { ok: true, result, attempts: attempt + 1 };
    } catch (err) {
      lastError = err;
      if (attempt === maxRetries) break;
      const delay = jitterDelay(attempt, { baseDelayMs, maxDelayMs, random });
      await sleeper(delay);
    }
  }

  let alertResults = null;
  if (typeof onFinalFailure === 'function') {
    try {
      alertResults = await onFinalFailure(lastError, payloads, maxRetries);
    } catch (alertErr) {
      alertResults = { alertError: alertErr && alertErr.message };
    }
  }

  return {
    ok: false,
    error: lastError ? String(lastError.stack || lastError.message || lastError) : 'unknown_error',
    attempts: maxRetries + 1,
    alertResults,
  };
}

module.exports = {
  jitterDelay,
  sleep,
  withRetries,
};
