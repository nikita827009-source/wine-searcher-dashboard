const crypto = require('crypto');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Bearer-token guard for mutating endpoints. Unset ADMIN_TOKEN => 503 (closed, never open). */
function requireAdmin(env = process.env) {
  return (req, res, next) => {
    const expected = env.ADMIN_TOKEN;
    if (!expected) return res.status(503).json({ error: { code: 'ADMIN_NOT_CONFIGURED', message: 'ADMIN_TOKEN is not configured on the server.' } });
    const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    if (!m) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing bearer token.' } });
    if (!safeEqual(m[1], expected)) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Invalid token.' } });
    next();
  };
}

module.exports = { requireAdmin };
