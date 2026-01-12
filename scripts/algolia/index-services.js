require("dotenv").config();
const algoliasearch = require("algoliasearch").default;
const { Client } = require("pg");

async function run() {
  const {
    ALGOLIA_APP_ID,
    ALGOLIA_ADMIN_KEY,
    ALGOLIA_INDEX_PREFIX = "bf_",
    DATABASE_URL,
  } = process.env;

  if (!ALGOLIA_APP_ID || !ALGOLIA_ADMIN_KEY || !DATABASE_URL) {
    throw new Error("Missing required env vars");
  }

  const algolia = algoliasearch(ALGOLIA_APP_ID, ALGOLIA_ADMIN_KEY);
  const index = algolia.initIndex(`${ALGOLIA_INDEX_PREFIX}services`);

  const db = new Client({ connectionString: DATABASE_URL });
  await db.connect();

  const { rows } = await db.query(`
    SELECT
      id,
      tenant_id,
      name,
      description,
      price_jd,
      duration_minutes,
      slot_interval_minutes,
      max_consecutive_slots,
      requires_staff,
      requires_resource,
      availability_basis,
      is_active
    FROM services
    WHERE is_active = true
  `);

  await db.end();

  const objects = rows.map(r => ({
    objectID: `service_${r.id}`,
    ...r
  }));

  await index.saveObjects(objects);
  await index.setSettings({
    searchableAttributes: ["name", "description"],
    attributesForFaceting: [
      "tenant_id",
      "requires_staff",
      "requires_resource",
      "availability_basis"
    ]
  });

  console.log(`✅ Indexed ${objects.length} services`);
}

run().catch(err => {
  console.error("❌ Algolia indexing failed:", err);
  process.exit(1);
});
