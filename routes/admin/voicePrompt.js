"use strict";

/**
 * VOICE-FIX-6 — Admin endpoints for per-tenant voice prompts
 *
 * Mounted at:  /api/admin/voice-prompt
 *
 * Routes (all auth-gated by requireAdmin middleware via ADMIN_API_KEY):
 *   GET    /api/admin/voice-prompt/:slug             → read current snapshot
 *   POST   /api/admin/voice-prompt/:slug/generate    → regenerate from DB and save
 *   POST   /api/admin/voice-prompt/:slug/dry-run     → generate without saving (preview)
 *   PUT    /api/admin/voice-prompt/:slug             → manually overwrite the prompt text
 *   DELETE /api/admin/voice-prompt/:slug             → clear snapshot (revert to fallback)
 *
 * The slug is the tenant slug (e.g., "birdie-golf") — easier to type via curl
 * than the numeric id.
 *
 * Auth: caller must include
 *   Authorization: Bearer <ADMIN_API_KEY>
 *   or x-admin-key: <ADMIN_API_KEY>
 *
 * No tenant-feature gating happens here — this is the dev/admin path. The
 * runtime feature gate (slug whitelist for who actually USES the snapshot)
 * lives in utils/voiceContext.js.
 */

const express = require("express");
const router = express.Router();
const db = require("../../db");
const requireAdmin = require("../../middleware/requireAdmin");
const {
  generateVoicePromptForTenant,
  readVoicePromptSnapshot,
  overwriteVoicePrompt,
  clearVoicePromptSnapshot,
} = require("../../utils/voicePromptGenerator");

router.use(requireAdmin);

async function resolveTenantBySlug(slug) {
  const r = await db.query(
    `SELECT id, slug, name FROM tenants WHERE slug = $1 LIMIT 1`,
    [slug]
  );
  return r.rows[0] || null;
}

// ── GET — read the current snapshot ──────────────────────────────────────
router.get("/:slug", async (req, res) => {
  try {
    const tenant = await resolveTenantBySlug(req.params.slug);
    if (!tenant) return res.status(404).json({ error: "tenant_not_found" });
    const snapshot = await readVoicePromptSnapshot(tenant.id);
    return res.json({
      tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
      snapshot, // null if not generated yet
    });
  } catch (e) {
    console.error("[admin/voice-prompt GET]", e);
    return res.status(500).json({ error: "internal_error", message: e.message });
  }
});

// ── POST /generate — generate fresh prompt from current DB context, SAVE it ──
router.post("/:slug/generate", async (req, res) => {
  try {
    const tenant = await resolveTenantBySlug(req.params.slug);
    if (!tenant) return res.status(404).json({ error: "tenant_not_found" });
    console.log(`[admin/voice-prompt] generating for tenant ${tenant.slug} (id ${tenant.id})`);
    const start = Date.now();
    const result = await generateVoicePromptForTenant(tenant.id, {
      modelOverride: req.body?.model || undefined,
    });
    const ms = Date.now() - start;
    console.log(`[admin/voice-prompt] generated for ${tenant.slug} in ${ms}ms — ${result.snapshot.prompt.length} chars`);
    return res.json({
      tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
      snapshot: result.snapshot,
      timing_ms: ms,
    });
  } catch (e) {
    console.error("[admin/voice-prompt generate]", e);
    return res.status(500).json({
      error: e.code || "generation_failed",
      message: e.message,
      detail: e.detail,
    });
  }
});

// ── POST /dry-run — generate but DON'T save (for preview) ────────────────
router.post("/:slug/dry-run", async (req, res) => {
  try {
    const tenant = await resolveTenantBySlug(req.params.slug);
    if (!tenant) return res.status(404).json({ error: "tenant_not_found" });
    const start = Date.now();
    const result = await generateVoicePromptForTenant(tenant.id, {
      modelOverride: req.body?.model || undefined,
      dryRun: true,
    });
    const ms = Date.now() - start;
    return res.json({
      tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
      snapshot: result.snapshot,
      saved: false,
      timing_ms: ms,
    });
  } catch (e) {
    console.error("[admin/voice-prompt dry-run]", e);
    return res.status(500).json({ error: e.code || "generation_failed", message: e.message });
  }
});

// ── PUT — manually overwrite the prompt text ─────────────────────────────
router.put("/:slug", async (req, res) => {
  try {
    const tenant = await resolveTenantBySlug(req.params.slug);
    if (!tenant) return res.status(404).json({ error: "tenant_not_found" });
    const promptText = req.body?.prompt;
    if (typeof promptText !== "string" || promptText.trim().length < 50) {
      return res.status(400).json({
        error: "invalid_prompt",
        message: "Body must include {\"prompt\": \"<at least 50 chars>\"}",
      });
    }
    const snapshot = await overwriteVoicePrompt(tenant.id, promptText);
    return res.json({
      tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
      snapshot,
    });
  } catch (e) {
    console.error("[admin/voice-prompt PUT]", e);
    return res.status(500).json({ error: e.code || "save_failed", message: e.message });
  }
});

// ── DELETE — clear snapshot, revert tenant to legacy fallback ────────────
router.delete("/:slug", async (req, res) => {
  try {
    const tenant = await resolveTenantBySlug(req.params.slug);
    if (!tenant) return res.status(404).json({ error: "tenant_not_found" });
    await clearVoicePromptSnapshot(tenant.id);
    return res.json({
      tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
      snapshot: null,
    });
  } catch (e) {
    console.error("[admin/voice-prompt DELETE]", e);
    return res.status(500).json({ error: "delete_failed", message: e.message });
  }
});

module.exports = router;
