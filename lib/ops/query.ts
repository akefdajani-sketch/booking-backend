export function cleanParams<T extends Record<string, any>>(
  params: T
): Partial<T> {
  const cleaned: Partial<T> = {};

  Object.entries(params).forEach(([key, value]) => {
    if (
      value !== undefined &&
      value !== null &&
      value !== "" &&
      !(Array.isArray(value) && value.length === 0)
    ) {
      (cleaned as any)[key] = value;
    }
  });

  return cleaned;
}

export function toQueryString(
  params: Record<string, string | number | boolean | undefined>
): string {
  const cleaned = cleanParams(params);
  const searchParams = new URLSearchParams();

  Object.entries(cleaned).forEach(([key, value]) => {
    searchParams.append(key, String(value));
  });

  return searchParams.toString();
}
