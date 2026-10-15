const DEFAULT_TIMEOUT_MS = 60000; // matches Actual Budget's Enable Banking timeout

// Without a timeout one hung request freezes the whole sequential sync (the Docker
// scheduler waits on each script), so every outbound call goes through here.
async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchWithTimeout };
