// ADR: serve the compaction popover + proxy its stream/nuke under LibreChat's own
// https origin, so the overlay iframe has no mixed-content / CORS issue. All real
// logic lives in the Python service at :8095 (host.docker.internal from the container).
const express = require('express');
const http = require('http');
const router = express.Router();
const UP = { host: 'host.docker.internal', port: 8095 };

// the popover page itself
router.get('/ui', (req, res) => {
  const cid = String(req.query.cid || '');
  const up = http.request({ ...UP, path: '/compact?cid=' + encodeURIComponent(cid), method: 'GET' }, (r) => {
    res.status(r.statusCode || 200).set('Content-Type', 'text/html; charset=utf-8');
    r.pipe(res);
  });
  up.on('error', (e) => res.status(502).send('dreamer upstream error: ' + e.message));
  up.end();
});

// live compaction stream (SSE). MUST flush each event through Express — LibreChat's
// compression middleware otherwise buffers the whole stream and the browser sees
// nothing until the fold ends (looks frozen on a cold fold). res.flush() forces the
// gzip buffer out per event; 'no-transform' asks compression to skip entirely.
router.get('/api/base', (req, res) => {
  const q = new URLSearchParams(req.query).toString();
  const up = http.request({ ...UP, path: '/api/base?' + q, method: 'GET' }, (r) => {
    res.status(r.statusCode || 200);
    res.set('Content-Type', 'text/event-stream');
    res.set('Cache-Control', 'no-cache, no-transform');
    res.set('X-Accel-Buffering', 'no');
    res.set('Connection', 'keep-alive');
    if (res.flushHeaders) res.flushHeaders();
    r.on('data', (c) => { res.write(c); if (res.flush) res.flush(); });
    r.on('end', () => { try { res.end(); } catch (_) {} });
  });
  up.on('error', () => { try { res.end(); } catch (_) {} });
  req.on('close', () => up.destroy());
  up.end();
});

// nuke & replace
router.post('/api/nuke', express.json({ limit: '4mb' }), (req, res) => {
  const body = JSON.stringify(req.body || {});
  const up = http.request({ ...UP, path: '/api/nuke', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (r) => {
    res.status(r.statusCode || 200).set('Content-Type', 'application/json');
    r.pipe(res);
  });
  up.on('error', (e) => res.status(502).json({ ok: false, error: e.message }));
  up.write(body); up.end();
});

router.get('/api/lag', (req, res) => {
  const q = new URLSearchParams(req.query).toString();
  const up = http.request({ ...UP, path: '/api/lag?' + q, method: 'GET' }, (r) => {
    res.status(r.statusCode || 200).set('Content-Type', 'application/json'); r.pipe(res);
  });
  up.on('error', (e) => res.status(502).json({ ok: false, error: e.message }));
  up.end();
});

// live spy popover page (lag + fold stream + continuous-mode toggle)
router.get('/spy_ui', (req, res) => {
  const up = http.request({ ...UP, path: '/spy_ui', method: 'GET' }, (r) => {
    res.status(r.statusCode || 200).set('Content-Type', 'text/html; charset=utf-8');
    r.pipe(res);
  });
  up.on('error', (e) => res.status(502).send('dreamer upstream error: ' + e.message));
  up.end();
});

// live spy stream (SSE) — flush per event like /api/base or it buffers to a freeze
router.get('/api/spy', (req, res) => {
  const q = new URLSearchParams(req.query).toString();
  const up = http.request({ ...UP, path: '/api/spy?' + q, method: 'GET' }, (r) => {
    res.status(r.statusCode || 200);
    res.set('Content-Type', 'text/event-stream');
    res.set('Cache-Control', 'no-cache, no-transform');
    res.set('X-Accel-Buffering', 'no');
    res.set('Connection', 'keep-alive');
    if (res.flushHeaders) res.flushHeaders();
    r.on('data', (c) => { res.write(c); if (res.flush) res.flush(); });
    r.on('end', () => { try { res.end(); } catch (_) {} });
  });
  up.on('error', () => { try { res.end(); } catch (_) {} });
  req.on('close', () => up.destroy());
  up.end();
});

// per-chat continuous-compaction mode (read + set)
router.get('/api/mode', (req, res) => {
  const q = new URLSearchParams(req.query).toString();
  const up = http.request({ ...UP, path: '/api/mode?' + q, method: 'GET' }, (r) => {
    res.status(r.statusCode || 200).set('Content-Type', 'application/json'); r.pipe(res);
  });
  up.on('error', (e) => res.status(502).json({ ok: false, error: e.message }));
  up.end();
});
router.post('/api/mode', express.json({ limit: '1mb' }), (req, res) => {
  const body = JSON.stringify(req.body || {});
  const up = http.request({ ...UP, path: '/api/mode', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (r) => {
    res.status(r.statusCode || 200).set('Content-Type', 'application/json');
    r.pipe(res);
  });
  up.on('error', (e) => res.status(502).json({ ok: false, error: e.message }));
  up.write(body); up.end();
});

module.exports = router;
