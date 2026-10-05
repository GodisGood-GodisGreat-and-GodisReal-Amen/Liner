// Liner — the export's uploads, off the main thread. The page hands over each slice of encoded video (the buffer is
// transferred, not copied) and this worker posts it to the server, so the thread that draws and feeds the hardware
// encoder never spends its time pushing bytes through the network stack.
self.onmessage = async (e) => {
  const { id, url, body } = e.data;
  try {
    const r = await fetch(url, { method: 'POST', body });
    if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error || 'The server stopped accepting frames.'); }
    self.postMessage({ id, ok: true });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err && err.message ? err.message : String(err) });
  }
};
