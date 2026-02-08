const requireGoogleAuth = require('./requireGoogleAuth');
const ensureUser = require('./ensureUser');
const { requireTenantRole } = require('./requireTenantRole');

function isValidAdminKey(req) {
  const rawAuth = String(req.headers.authorization || '');
  const bearer = rawAuth.toLowerCase().startsWith('bearer ')
    ? rawAuth.slice(7).trim()
    : null;

  const key = bearer || String(req.headers['x-admin-key'] || '').trim() || String(req.headers['x-api-key'] || '').trim();
  const expected = String(process.env.ADMIN_API_KEY || '').trim();
  if (!expected) return false;
  if (!key) return false;
  return key === expected;
}

function run(mw, req, res) {
  return new Promise((resolve, reject) => {
    try {
      mw(req, res, (err) => {
        if (err) return reject(err);
        return resolve();
      });
    } catch (e) {
      return reject(e);
    }
  });
}

module.exports = function requireAdminOrTenantRole(minRole) {
  const roleMw = requireTenantRole(minRole);

  return async function (req, res, next) {
    try {
      if (isValidAdminKey(req)) {
        req.adminBypass = true;
        return next();
      }

      await run(requireGoogleAuth, req, res);
      if (res.headersSent) return;
      await run(ensureUser, req, res);
      if (res.headersSent) return;
      await run(roleMw, req, res);
      if (res.headersSent) return;

      return next();
    } catch (err) {
      console.error('requireAdminOrTenantRole error:', err);
      if (res.headersSent) return;
      return res.status(500).json({ error: 'Failed to authorize.' });
    }
  };
};
