INSERT INTO platform_themes (
  key,
  name,
  layout_key,
  tokens_json,
  is_active,
  created_at,
  updated_at
)
SELECT
  'premium_v2',
  'Premium v2',
  'premium',
  tokens_json,
  is_active,
  now(),
  now()
FROM platform_themes
WHERE key = 'premium'
AND NOT EXISTS (
  SELECT 1 FROM platform_themes WHERE key = 'premium_v2'
);
