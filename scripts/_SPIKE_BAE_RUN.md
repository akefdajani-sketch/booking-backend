# BAE Microform v2 Spike — Run Guide

End-to-end smoke test of Cybersource Flex Microform v2 against Bank al Etihad's test environment. Spike only. **Not** wired to bookings, tenants, or the DB.

Files:
- `routes/payments/_spike.js`  — backend endpoints A (capture-context) and B (finalize)
- `app.js`                     — mount under `// SPIKE — REMOVE BEFORE PROD ADAPTER MERGE`
- `scripts/_spike-bae-test.html` — standalone browser test page
- `scripts/_SPIKE_BAE_RUN.md`  — this doc

---

## 0. One-time setup

This worktree starts without `node_modules`. From the repo root in PowerShell:

```powershell
npm install
```

Required in `.env`:

```
ETIHAD_TEST_AUTH=<bearer token issued for capture-context — already present>
```

---

## 1. Verify the feature flag gates both endpoints (404 when off)

Start the backend **without** the flag in PowerShell:

```powershell
$env:PORT="3001"
node index.js
```

In another PowerShell window:

```powershell
curl.exe -i -X POST http://localhost:3001/api/payments/_spike/capture-context -H "Content-Type: application/json" -d "{}"
curl.exe -i -X POST http://localhost:3001/api/payments/_spike/finalize          -H "Content-Type: application/json" -d "{\"transientToken\":\"x\"}"
```

**Expected:** both return `HTTP/1.1 404` with `{"error":"Not found"}`. Stop the backend.

---

## 2. Start the backend with the flag on

```powershell
$env:BAE_SPIKE_ENABLED="true"
$env:PORT="3001"
node index.js
```

PowerShell-specific gotcha: do **not** use bash inline form (`BAE_SPIKE_ENABLED=true node index.js`). PowerShell parses this as a command with arguments, the env var never gets set, the backend boots without the flag, and the endpoints silently 404. Use `$env:VAR="value"` on its own line first.

Sanity check the flag took:

```powershell
curl.exe -i -X POST http://localhost:3001/api/payments/_spike/capture-context -H "Content-Type: application/json" -d "{}"
```

**Expected:** `HTTP/1.1 200` and a JSON body with `token` (the JWT), `clientLibrary`, `clientLibraryIntegrity`.

If you get `500 spike_misconfigured`: `ETIHAD_TEST_AUTH` isn't set. Confirm `.env` is being loaded (the backend reads it via `dotenv` at boot).

---

## 3. Open the test page

The HTML page uses `fetch()` to call `http://localhost:3001` from a `file://` origin. The backend's existing CORS middleware allows the configured `allowedOrigins`; `file://` requests send `Origin: null`, which is accepted by Cybersource (we forward it as `targetOrigins[0]`) but may be blocked by our CORS layer.

Open the page:

```powershell
Start-Process scripts\_spike-bae-test.html
```

If browser console shows a CORS error on the `fetch` to `/api/payments/_spike/capture-context`, either:
- temporarily add `null` to `allowedOrigins` in `.env` (`ALLOWED_ORIGINS=null,http://localhost:3001`), **or**
- serve the file from a local origin: `npx --yes http-server scripts -p 5500 -c-1 -o _spike-bae-test.html`, then in the page set the Backend URL to `http://localhost:3001`.

### Walkthrough

| Step | Action | Expected |
|------|--------|----------|
| 1 | Click **Fetch capture-context** | Log shows `clientLibrary`, integrity, and first 40 chars of JWT. SDK script loads with `integrity="sha256-…"` — browser DevTools Network tab shows the request succeeded **with SRI verified**. Microform iframes appear in the card-number and CVV slots. |
| 2 | Type `4111 1111 1111 1111` in the card field, any CVV (e.g. `123`), expiry `12 / 2030`. Click **Capture transient token** | Log shows `OK — transient token (JWT) acquired:` followed by the first 80 chars of the JWT. |
| 3 | Click **POST /finalize** | Log shows the upstream response from `/pts/v2/payments`. See "Interpreting step 3" below. |

---

## Interpreting step 3

The /pts/v2/payments call is the part we are **least certain about**. Possible outcomes:

| Upstream status | Meaning | Next move |
|-----------------|---------|-----------|
| `200`/`201` | Bearer token is valid for /pts/v2/* (unexpected). Payment authorized. | Spike succeeds. Document the auth model + host that worked. |
| `401`/`403` | Bearer token is **not** accepted by /pts/v2/*. This is the expected outcome. | Ask BAE for HTTP-Signature credentials (merchant id, key, base64 secret). Re-run with `$env:BAE_PTS_AUTH_MODE="http-signature"`. |
| `404` | Host or path wrong. | Try a different `BAE_PTS_HOST` (e.g. `apitest.cybersource.com`, or a BAE-specific subdomain if they publish one). |
| `400` | Auth worked, but payload is wrong. | Look at upstream `body` for which field — likely `billTo` or merchant configuration. |

### HTTP-Signature mode (if BAE provides creds)

```powershell
$env:BAE_PTS_AUTH_MODE="http-signature"
$env:BAE_PTS_MERCHANT_ID="<from BAE>"
$env:BAE_PTS_KEY="<from BAE>"
$env:BAE_PTS_SECRET="<base64 — from BAE>"
$env:BAE_PTS_HOST="apitest.cybersource.com"   # or BAE-specific host
node index.js
```

Without all three (MID/KEY/SECRET), `/finalize` returns **501 missing_credentials**. It does not fall back to bearer — by design.

---

## Fallback: Unified Checkout

The BAE PDF documents `Accept(token).unifiedPayments()` (Unified Checkout), not the `new Flex(jwt).microform(...)` flow this page uses. We start with Microform because it is the leaner, more flexible integration and the capture-context response (`clientLibrary: testup.cybersource.com/v2/...`) suggests Microform is in scope.

**If the SDK loads but Microform mount throws** ("capture-context rejected", "invalid client version", etc.), the JWT may be provisioned for Unified Checkout only. Do not rewrite the page in advance — the error message will tell us. The minimal change to switch:

1. In `_spike.js`, drop `clientVersion: 'v2'` and `captureMandate` from the capture-context request, or set `clientVersion: '0.20'` per the BAE PDF.
2. In the HTML page, replace the `new Flex(jwt)` + `microform.createField(...)` block with:

   ```js
   const accept = new Accept(jwt);
   const up = await accept.unifiedPayments(true);
   const result = await up.show({ containerSelector: '#cardNumber' });
   // result.token is the transient token; POST to /finalize
   ```

3. The /finalize endpoint does not change — it still receives a transient token JWT.

Open question: whether BAE's tenant configuration permits Microform at all. Smoke test today suggests yes (capture-context succeeded with Microform-style request), but the SDK mount is the first hard signal.

---

## What to capture and report back

After step 3, report:

- [ ] **SDK fetched, SRI verified?** (DevTools Network tab — green checkmark / no SRI warning)
- [ ] **Microform iframes mounted?** (visible card-number / CVV inputs)
- [ ] **Transient token JWT acquired?** (yes / no; if no, paste the `createToken` error)
- [ ] **/pts/v2/payments upstream status code?** (and the full response body from the `logFinalize` panel)
- [ ] **Backend logs** for the two endpoints (`pino` output around `[bae-spike]`)

Do **not** paste `ETIHAD_TEST_AUTH`, the contents of `.env`, or full unredacted card metadata into the report.

---

## Teardown

```powershell
# stop the backend (Ctrl+C in its window), then:
Remove-Item env:BAE_SPIKE_ENABLED
Remove-Item env:BAE_PTS_AUTH_MODE -ErrorAction SilentlyContinue
Remove-Item env:BAE_PTS_MERCHANT_ID -ErrorAction SilentlyContinue
Remove-Item env:BAE_PTS_KEY -ErrorAction SilentlyContinue
Remove-Item env:BAE_PTS_SECRET -ErrorAction SilentlyContinue
Remove-Item env:BAE_PTS_HOST -ErrorAction SilentlyContinue
```

The spike code stays in the worktree but is invisible without `BAE_SPIKE_ENABLED=true`. Do not merge.
