export const DEFAULT_API_BASE =
  process.env.NEXT_PUBLIC_API_BASE || "";

export function buildApiUrl(
  path: string,
  query?: Record<string, string | number | boolean | undefined>
): string {
  const base = DEFAULT_API_BASE.replace(/\/$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  if (!query || Object.keys(query).length === 0) {
    return `${base}${normalizedPath}`;
  }

  const params = new URLSearchParams();

  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      params.append(key, String(value));
    }
  });

  return `${base}${normalizedPath}?${params.toString()}`;
}

export async function safeJson<T = unknown>(
  response: Response
): Promise<T> {
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `API Error (${response.status}): ${text || response.statusText}`
    );
  }

  return response.json();
}
