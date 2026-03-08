'use strict';

// middleware/apiVersion.js
// PR-3: API Versioning
//
// Adds X-API-Version header to every response so clients can detect
// the API version without parsing URLs.
//
// Current API is v1. When breaking changes are introduced in future,
// bump API_VERSION and add /api/v2 route mounts in app.js.
//
// Usage in app.js (add before routes):
//   app.use(require('./middleware/apiVersion'));

const API_VERSION = '1';

module.exports = function apiVersion(req, res, next) {
  res.setHeader('X-API-Version', API_VERSION);
  next();
};
