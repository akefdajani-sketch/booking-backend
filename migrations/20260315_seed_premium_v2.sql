INSERT INTO platform_themes (
  key,
  name,
  layout_key,
  tokens_json,
  is_published,
  created_at,
  updated_at
)
SELECT
  'premium_v2',
  'Premium v2',
  COALESCE(layout_key, 'premium'),
  COALESCE(tokens_json, '{}'::jsonb),
  TRUE,
  NOW(),
  NOW()
FROM platform_themes
WHERE key = 'premium'
  AND NOT EXISTS (
    SELECT 1 FROM platform_themes WHERE key = 'premium_v2'
  );
