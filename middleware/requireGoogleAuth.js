// src/middleware/requireGoogleAuth.js

const { OAuth2Client } = require("google-auth-library");

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

module.exports = async function requireGoogleAuth(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const match = auth.match(/^Bearer\s+(.+)$/i);

    if (!match) {
      return res.status(401).json({ error: "Missing Bearer token" });
    }

    const idToken = match[1];

    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();

    req.user = {
      email: payload.email,
      sub: payload.sub,
      name: payload.name,
      picture: payload.picture,
    };

    return next();
  } catch (err) {
    console.error("Auth error:", err.message);
    return res.status(401).json({ error: "Invalid or expired Google token" });
  }
};
