// middleware/requireGoogleAuth.js
const { OAuth2Client } = require("google-auth-library");

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

function parseBearerToken(authHeader) {
  const auth = authHeader || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

module.exports = async function requireGoogleAuth(req, res, next) {
  try {
    const idToken = parseBearerToken(req.headers.authorization);
    if (!idToken) {
      return res.status(401).json({ error: "Missing Bearer token" });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      return res.status(401).json({ error: "Invalid Google token payload" });
    }

    req.user = {
      email: payload.email,
      sub: payload.sub,
      name: payload.name,
      picture: payload.picture,
    };

    return next();
  } catch (err) {
    // google-auth-library can throw a generic error message like:
    // "Token used too late, <now> > <exp>: {...payload...}"
    const msg = String(err?.message || "");

    // Detect expiry clearly
    if (msg.toLowerCase().includes("token used too late")) {
      console.warn("Auth error: Google token expired");
      return res.status(401).json({
        error: "Google token expired. Please sign in again.",
        code: "GOOGLE_TOKEN_EXPIRED",
      });
    }

    // Other common cases
    if (msg.toLowerCase().includes("wrong number of segments")) {
      return res.status(401).json({
        error: "Malformed Bearer token",
        code: "GOOGLE_TOKEN_MALFORMED",
      });
    }

    // Fallback
    console.warn("Auth error:", msg);
    return res.status(401).json({
      error: "Invalid Google token",
      code: "GOOGLE_TOKEN_INVALID",
    });
  }
};
