import * as React from "react";

import { runOptimistic } from "./_optimistic";
import { toast } from "@/lib/toast";

// Generic resources hook (mirrors useSetupStaff / useSetupServices patterns)
// Includes optional Resource ↔ Services link map.

type NormalizeFn<T> = (payload: any) => T[];

function defaultNormalize<T>(payload: any): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (!payload || typeof payload !== "object") return [];

  const p: any = payload;
  if (Array.isArray(p.resources)) return p.resources;
  if (Array.isArray(p.data)) return p.data;
  if (Array.isArray(p.rows)) return p.rows;
  if (Array.isArray(p.items)) return p.items;

  if (p.resources && typeof p.resources === "object") {
    if (Array.isArray(p.resources.rows)) return p.resources.rows;
    if (Array.isArray(p.resources.items)) return p.resources.items;
  }

  return [];
}

export function useSetupResources<T = any>(args: {
  apiBase: string;
  enabled?: boolean;
  normalize?: NormalizeFn<T>;
}) {
  const { apiBase, enabled = true, normalize = defaultNormalize } = args;

  const [resources, setResources] = React.useState<T[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<Record<string, boolean>>({});

  const isPending = React.useCallback((key: string) => Boolean(pending[key]), [pending]);

  // Resource ↔ Services links
  // Protocol: if a resource has NO links, booking treats it as available for ALL services.
  const [resourceServiceMap, setResourceServiceMap] = React.useState<Record<number, number[]>>({});
  const [linksLoading, setLinksLoading] = React.useState(false);
  const [linksError, setLinksError] = React.useState<string | null>(null);

  const abortRef = React.useRef<AbortController | null>(null);
  const lastTenantSlugRef = React.useRef<string>("");
  const lastTenantIdRef = React.useRef<number | string | null>(null);

  // Step 13: stale-request guard (prevents older responses from overwriting newer optimistic state).
  const opVersionRef = React.useRef<Record<string, number>>({});
  const bumpVersion = React.useCallback((key: string) => {
    const next = (opVersionRef.current[key] || 0) + 1;
    opVersionRef.current[key] = next;
    return next;
  }, []);
  const isStale = React.useCallback((key: string, version: number) => {
    return (opVersionRef.current[key] || 0) !== version;
  }, []);

  const fetchResourceServiceMap = React.useCallback(
    async (params: { tenantSlug?: string | null }) => {
      if (!enabled) return;
      const tenantSlug = params.tenantSlug ? String(params.tenantSlug) : lastTenantSlugRef.current;
      if (!tenantSlug) return;

      setLinksLoading(true);
      setLinksError(null);
      try {
        const res = await fetch(
          `${apiBase}/links/tenant?tenantSlug=${encodeURIComponent(tenantSlug)}`,
          { method: "GET", cache: "no-store" }
        );
        const json: any = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json?.error || `Failed to load resource links (HTTP ${res.status})`);

        const rows: Array<{ resource_id: number; service_id: number }> = Array.isArray(json?.resource_services)
          ? json.resource_services
          : [];

        const rm: Record<number, number[]> = {};
        for (const r of rows) {
          const rid = Number((r as any).resource_id);
          const svc = Number((r as any).service_id);
          if (!Number.isFinite(rid) || !Number.isFinite(svc)) continue;
          rm[rid] = rm[rid] || [];
          rm[rid].push(svc);
        }

        setResourceServiceMap(rm);
      } catch (e: any) {
        setLinksError(e?.message || "Failed to load resource links");
      } finally {
        setLinksLoading(false);
      }
    },
    [apiBase, enabled]
  );

  const refetchLinks = React.useCallback(async () => {
    if (!enabled) return;
    const tenantSlug = lastTenantSlugRef.current;
    if (!tenantSlug) return;
    await fetchResourceServiceMap({ tenantSlug });
  }, [enabled, fetchResourceServiceMap]);

  async function setResourceServices(resourceId: number, serviceIds: number[]) {
    const nextIds = Array.from(
      new Set((serviceIds || []).map((x) => Number(x)).filter((x) => Number.isFinite(x)))
    );

    const pendingKey = `resource:link:${resourceId}`;
    const v = bumpVersion(pendingKey);

    await runOptimistic<Record<number, number[]>, true>({
      setState: setResourceServiceMap,
      setPending,
      pendingKey,
      isStale: () => isStale(pendingKey, v),
      optimistic: (m) => ({ ...m, [resourceId]: [...nextIds] }),
      request: async () => {
        const res = await fetch(`${apiBase}/links/resource/${resourceId}/services`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ service_ids: nextIds }),
        });
        const json: any = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json?.error || json?.message || "Failed to save resource links");
        return true;
      },
      rollback: refetchLinks,
      onError: (err) => {
        console.error("Failed to save resource links, rolling back", err);
        toast.error("Couldn’t save resource links — reverted.");
      },
    });
  }

  async function assignServiceToResource(resourceId: number, serviceId: number) {
    const current = resourceServiceMap[resourceId] || [];
    if (current.includes(serviceId)) return;
    await setResourceServices(resourceId, [...current, serviceId]);
  }

  async function unassignServiceFromResource(resourceId: number, serviceId: number) {
    const current = resourceServiceMap[resourceId] || [];
    if (!current.includes(serviceId)) return;
    await setResourceServices(resourceId, current.filter((x) => x !== serviceId));
  }

  const fetchResources = React.useCallback(
    async (params: {
      tenantSlug?: string | null;
      tenantId?: number | string | null;
      setResources?: (rows: T[]) => void;
    }) => {
      if (!enabled) return;

      const tenantSlug = params.tenantSlug ? String(params.tenantSlug) : "";
      const tenantId = params.tenantId ?? null;

      lastTenantSlugRef.current = tenantSlug;
      lastTenantIdRef.current = tenantId;

      const applyRows = (rows: T[]) => {
        if (typeof params.setResources === "function") params.setResources(rows);
        else setResources(rows);
      };

      const makeUrl = (mode: "slug" | "id") => {
        const u = new URL(`${apiBase}/resources`, window.location.origin);
        if (mode === "slug" && tenantSlug) u.searchParams.set("tenantSlug", tenantSlug);
        if (mode === "id" && tenantId != null) u.searchParams.set("tenantId", String(tenantId));
        return u.toString();
      };

      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      setLoading(true);
      setError(null);

      try {
        let res: Response | null = null;
        let json: any = null;

        if (tenantSlug) {
          res = await fetch(makeUrl("slug"), { signal: ac.signal, cache: "no-store" });
          json = await res.json().catch(() => ({}));
          if (res.ok) {
            applyRows(normalize(json));
            return;
          }
        }

        if (tenantId != null) {
          res = await fetch(makeUrl("id"), { signal: ac.signal, cache: "no-store" });
          json = await res.json().catch(() => ({}));
          if (res.ok) {
            applyRows(normalize(json));
            return;
          }
        }

        const msg =
          (json && (json.error || json.message)) ||
          (res ? `Failed to load resources (${res.status})` : "Failed to load resources");
        throw new Error(msg);
      } catch (e: any) {
        if (e?.name === "AbortError") return;
        setError(e?.message || "Failed to load resources");
      } finally {
        setLoading(false);
      }
    },
    [apiBase, enabled, normalize]
  );

  const refetch = React.useCallback(async () => {
    if (!enabled) return;
    const tenantSlug = lastTenantSlugRef.current;
    const tenantId = lastTenantIdRef.current;
    if (!tenantSlug && tenantId == null) return;
    await fetchResources({ tenantSlug, tenantId, setResources });
  }, [enabled, fetchResources]);

  async function patchResource(resourceId: number, payload: Partial<T>) {
    const pendingKey = `resource:patch:${resourceId}`;
    const v = bumpVersion(pendingKey);

    await runOptimistic<T[], any>({
      setState: setResources,
      setPending,
      pendingKey,
      isStale: () => isStale(pendingKey, v),
      optimistic: (prev) =>
        prev.map((r: any) => (r?.id === resourceId ? { ...r, ...(payload as any) } : r)),
      request: async () => {
        const res = await fetch(`${apiBase}/resources/${resourceId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error("Patch failed");
        const json: any = await res.json().catch(() => null);
        return (json && (json.resource || json)) || null;
      },
      commit: (updated) => {
        if (updated && typeof updated === "object" && (updated as any).id != null) {
          const updatedId = (updated as any).id;
          return (prev) => prev.map((r: any) => (r?.id === updatedId ? { ...r, ...updated } : r));
        }
      },
      rollback: refetch,
      onError: (err) => {
        console.error("Patch failed, rolling back", err);
        toast.error("Couldn’t save resource changes — reverted.");
      },
    }).catch(() => {
      // Preserve previous behavior: patchResource does not throw.
    });
  }

  async function createResource(payload: Partial<T> & Record<string, any>) {
    const tenantSlug = payload?.tenantSlug ?? lastTenantSlugRef.current;
    const tenantId = payload?.tenantId ?? payload?.tenant_id ?? lastTenantIdRef.current;

    const finalPayload: any = { ...payload };
    if (tenantSlug && finalPayload.tenantSlug == null) finalPayload.tenantSlug = tenantSlug;
    if (tenantId != null) {
      if (finalPayload.tenantId == null) finalPayload.tenantId = tenantId;
      if (finalPayload.tenant_id == null) finalPayload.tenant_id = tenantId;
    }

    const tempId = -Math.floor(Date.now() / 1000);
    const optimistic: any = { id: tempId, ...finalPayload };

    const pendingKey = `resource:create`;
    const v = bumpVersion(pendingKey);

    const created = await runOptimistic<T[], any>({
      setState: setResources,
      setPending,
      pendingKey,
      isStale: () => isStale(pendingKey, v),
      optimistic: (prev) => [...prev, optimistic],
      request: async () => {
        const res = await fetch(`${apiBase}/resources`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(finalPayload),
        });

        const json: any = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json?.error || json?.message || "Create failed");
        return (json && (json.resource || json)) || null;
      },
      commit: (createdRow) => {
        if (createdRow && typeof createdRow === "object" && (createdRow as any).id != null) {
          return (prev) =>
            prev.map((r: any) =>
              r?.id === tempId ? { ...r, ...createdRow, id: (createdRow as any).id } : r
            );
        }
      },
      rollback: refetch,
      onError: (err) => {
        console.error("Create failed, rolling back", err);
        toast.error("Couldn’t create resource — reverted.");
      },
    });

    if (!(created && typeof created === "object" && (created as any).id != null)) {
      await refetch();
    }

    return created as T;
  }

  async function updateResource(resourceId: number, payload: Partial<T> & Record<string, any>) {
    const pendingKey = `resource:update:${resourceId}`;
    const v = bumpVersion(pendingKey);

    const updated = await runOptimistic<T[], any>({
      setState: setResources,
      setPending,
      pendingKey,
      isStale: () => isStale(pendingKey, v),
      optimistic: (prev) =>
        prev.map((r: any) => (r?.id === resourceId ? { ...r, ...(payload as any) } : r)),
      request: async () => {
        const res = await fetch(`${apiBase}/resources/${resourceId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const json: any = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json?.error || json?.message || "Update failed");
        return (json && (json.resource || json)) || null;
      },
      commit: (updatedRow) => {
        if (updatedRow && typeof updatedRow === "object" && (updatedRow as any).id != null) {
          const updatedId = (updatedRow as any).id;
          return (prev) =>
            prev.map((r: any) => (r?.id === updatedId ? { ...r, ...updatedRow } : r));
        }
      },
      rollback: refetch,
      onError: (err) => {
        console.error("Update failed, rolling back", err);
        toast.error("Couldn’t update resource — reverted.");
      },
    });

    return updated as T;
  }

  async function deleteResource(resourceId: number) {
    const pendingKey = `resource:delete:${resourceId}`;
    const v = bumpVersion(pendingKey);

    const result = await runOptimistic<T[], { deactivated: boolean; updated: any }>({
      setState: setResources,
      setPending,
      pendingKey,
      isStale: () => isStale(pendingKey, v),
      optimistic: (prev) => prev.filter((r: any) => r?.id !== resourceId),
      request: async () => {
        const res = await fetch(`${apiBase}/resources/${resourceId}`, { method: "DELETE" });
        const json: any = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json?.error || json?.message || "Delete failed");

        return {
          deactivated: Boolean((json as any)?.deactivated),
          updated: (json && (json.resource || json)) || null,
        };
      },
      rollback: refetch,
      onError: (err) => {
        console.error("Delete failed, rolling back", err);
        toast.error("Couldn’t delete resource — reverted.");
      },
    });

    return result;
  }

  React.useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  return {
    resources,
    setResources,
    loading,
    error,
    pending,
    isPending,
    fetchResources,
    refetch,

    // Links
    resourceServiceMap,
    setResourceServiceMap,
    linksLoading,
    linksError,
    fetchResourceServiceMap,
    refetchLinks,
    setResourceServices,
    assignServiceToResource,
    unassignServiceFromResource,

    patchResource,
    createResource,
    updateResource,
    deleteResource,
  };
}
