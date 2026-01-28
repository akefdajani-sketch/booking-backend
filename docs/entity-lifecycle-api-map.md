3️⃣ How to Map Protocol → DB Constraints + API Behavior

(No code, just “what must happen where”)

This is where you prevent future regressions.

Step 3.1 — Create a Rules → Enforcement table

Example:

Rule	DB Enforcement	API Behavior
No delete if bookings exist	FK constraint	Catch + retire
Names editable anytime	No constraint	PATCH allowed
Active-only quotas	Count is_active=true	Block create
Images never block	Nullable image fields	Ignore on delete

This table is gold.

Step 3.2 — Define DB responsibilities (clearly)
Database must

Enforce referential integrity (FKs)

Prevent orphan bookings

Never cascade-delete historical data

Database must not

Decide UI behavior

Auto-delete entities

Step 3.3 — Define API responsibilities

For each entity (service, staff, resource), document:

DELETE /entity/:id

If zero bookings → hard delete

If bookings exist → retire and return { retired: true }

PATCH /entity/:id

Always allow name/image changes

Allow rule changes, forward-only

POST /entity

Block if active quota exceeded

Allow if replacing retired entity
