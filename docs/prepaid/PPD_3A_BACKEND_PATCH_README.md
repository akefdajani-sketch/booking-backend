# PPD-3A backend patch

This patch adds the first real prepaid accounting layer without changing the existing membership engine.

## Included

- `sql/PPD_3A_prepaid_accounting_schema.sql`
- `routes/tenantPrepaidAccounting.js`
- `app.js` mount for the new router

## New tenant-scoped endpoints

All routes are mounted under `/api/tenant/:slug`.

### Products
- `GET /prepaid-products`
- `POST /prepaid-products`
- `PATCH /prepaid-products/:productId`

### Entitlements
- `GET /prepaid-entitlements?customerId=&status=&limit=`
- `POST /prepaid-entitlements/grant`
- `POST /prepaid-entitlements/:entitlementId/adjust`

### Ledger / activity
- `GET /prepaid-transactions?customerId=&entitlementId=&limit=`
- `GET /prepaid-redemptions?customerId=&bookingId=&limit=`
- `POST /prepaid-redemptions`
- `GET /prepaid-accounting-summary`

## Roles

- Read endpoints: `staff+`
- Write endpoints: `manager+`
- Supports normal tenant Google auth or `ADMIN_API_KEY`

## Deploy order

1. Run `sql/PPD_3A_prepaid_accounting_schema.sql` on the production database.
2. Deploy the backend files.
3. Smoke test with the requests below.

## Smoke test

### 1) Products list should return 200

`GET /api/tenant/birdie-golf/prepaid-products`

### 2) Create a product

```json
{
  "product": {
    "name": "5 Golf Lessons",
    "productType": "service_package",
    "description": "Manual QA product",
    "isActive": true,
    "price": 150,
    "currency": "JOD",
    "validityUnit": "days",
    "validityValue": 90,
    "sessionCount": 5,
    "eligibleServiceIds": [16],
    "rules": { "notes": "phase-3a" }
  }
}
```

### 3) Grant an entitlement

```json
{
  "customerId": 123,
  "prepaidProductId": 1,
  "quantity": 5,
  "notes": "Manual grant for QA"
}
```

### 4) Adjust an entitlement

```json
{
  "quantityDelta": -1,
  "notes": "Manual correction"
}
```

### 5) Record a manual redemption

```json
{
  "customerId": 123,
  "entitlementId": 1,
  "redeemedQuantity": 1,
  "redemptionMode": "manual",
  "notes": "Phase-3A smoke test"
}
```

## Notes

- This patch intentionally does **not** wire checkout yet.
- This patch intentionally does **not** alter public booking flows yet.
- Products in `tenants.branding.prepaidCatalog` can coexist during transition.
- The new DB tables are the source of truth for future accounting work.
