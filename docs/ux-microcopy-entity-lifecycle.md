2️⃣ How to Extract a UX Micro-Copy Matrix

(“What the UI says, exactly, in every scenario”)

Goal

Remove ambiguity. The UI must explain the rules for you, so:

tenants don’t get confused

support tickets drop

behavior stays consistent forever

Step 2.1 — Define the trigger scenarios (this is the key move)

Create a simple table (doc, Notion, or markdown):

Scenario	Condition	Allowed Action
Delete entity	No bookings exist	Hard delete
Delete entity	Bookings exist	Retire instead
Edit name	Any time	Allowed
Change rules	Bookings exist	Applies to future only
Exceeded quota	Active count at limit	Block creation

You already defined these rules in the protocol — now we bind them to UI moments.

Step 2.2 — Write exact copy per scenario

(No dev interpretation, no guessing)

Example micro-copy matrix (this is what you literally give the frontend):

Delete attempt — entity has bookings

Title: Cannot delete this item
Body:

This item has already been used in bookings and cannot be deleted.
To protect your booking history, it has been retired instead.

CTA: OK

Retired badge tooltip

This item is retired. It is no longer available for new bookings but remains visible for past records.

Name edit (any entity)

Helper text:

You can update the name at any time. This will not affect past bookings.

Rule change warning (duration, capacity, etc.)

Inline notice:

Changes apply to future bookings only. Existing bookings are not affected.

Quota reached

Blocking message:

You’ve reached the maximum number of active services for your plan.
Retire an existing service or upgrade your plan to continue.
