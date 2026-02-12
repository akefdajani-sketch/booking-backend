"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { adminColors, adminRadii, adminSpace, adminZ } from "@/components/admin/AdminStyles";
import { KpiCard } from "@/components/admin/KpiCard";
import { TimeContextBar, type TimeMode } from "@/components/owner/TimeContextBar";
import { setTenantThemeKey } from "@/lib/api/tenantThemeKey";

import OwnerSetupTab from "@/components/owner/tabs/OwnerSetupTab";
import OwnerDayViewTab from "@/components/owner/tabs/OwnerDayViewTab";
import OwnerCustomersTab from "@/components/owner/tabs/OwnerCustomersTab";

import TeamScheduleClient from "@/components/tenant/TeamScheduleClient";

import ModalOverlay from "@/components/booking/ModalOverlay";
import ConfirmActionModal from "@/components/owner/ConfirmActionModal";
import { useOwnerMutations } from "@/lib/owner/useOwnerMutations";
import type { BookingRow } from "@/lib/owner/types";

import { type SetupSectionKey } from "@/components/owner/setup/SetupPills";

const OWNER_API = "/api/owner/proxy";

function stableStringify(value: any): string {
  const seen = new WeakSet();
  const sorter = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const normalize = (v: any): any => {
    if (v === undefined) return null;
    if (v === null) return null;
    if (typeof v !== "object") return v;
    if (seen.has(v)) return "[Circular]";
    seen.add(v);
    if (Array.isArray(v)) return v.map(normalize);
    const out: any = {};
    for (const k of Object.keys(v).sort(sorter)) out[k] = normalize(v[k]);
    return out;
  };
  try {
    return JSON.stringify(normalize(value));
  } catch {
    return "";
  }
}

function deepEqual(a: any, b: any): boolean {
  return stableStringify(a) === stableStringify(b);
}

// ---- Helpers --------------------------------------------------------------

function formatMoney(amount: number, currency: string = "USD") {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function formatLocalDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// Format a timestamp as YYYY-MM-DD HH:MM in the user's local timezone (no seconds)
function formatLocalDateTimeNoSeconds(input: string | Date): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return "";
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

// ---- UI icons (no extra deps) --------------------------------------------
function Icon({ name }: { name: "dashboard" | "bookings" | "add" | "day" | "customers" | "setup" }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  switch (name) {
    case "dashboard":
      return (
        <svg {...common}>
          <path d="M3 13h8V3H3v10z" />
          <path d="M13 21h8V11h-8v10z" />
          <path d="M13 3h8v6h-8V3z" />
          <path d="M3 21h8v-6H3v6z" />
        </svg>
      );
    case "bookings":
      return (
        <svg {...common}>
          <path d="M8 2v4" />
          <path d="M16 2v4" />
          <path d="M3 10h18" />
          <path d="M5 6h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" />
        </svg>
      );
    case "add":
      return (
        <svg {...common}>
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
      );
    case "day":
      return (
        <svg {...common}>
          <path d="M12 7v5l3 2" />
          <path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />
        </svg>
      );
    case "customers":
      return (
        <svg {...common}>
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <path d="M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" />
        </svg>
      );
    case "setup":
      return (
        <svg {...common}>
          <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z" />
          <path d="M19.4 15a1.8 1.8 0 0 0 .36 1.98l.04.04a2 2 0 0 1-1.41 3.41h-.06a1.8 1.8 0 0 0-1.58 1.02 2 2 0 0 1-3.62 0 1.8 1.8 0 0 0-1.58-1.02H9.6a1.8 1.8 0 0 0-1.58 1.02 2 2 0 0 1-3.62 0 2 2 0 0 1-1.41-3.41l.04-.04A1.8 1.8 0 0 0 4.6 15a2 2 0 0 1 0-6 1.8 1.8 0 0 0-.36-1.98l-.04-.04A2 2 0 0 1 5.61 3.6h.06A1.8 1.8 0 0 0 7.25 2.58a2 2 0 0 1 3.62 0 1.8 1.8 0 0 0 1.58 1.02h1.1a1.8 1.8 0 0 0 1.58-1.02 2 2 0 0 1 3.62 0 1.8 1.8 0 0 0 1.58 1.02h.06A2 2 0 0 1 21.4 7l-.04.04A1.8 1.8 0 0 0 19.4 9a2 2 0 0 1 0 6z" />
        </svg>
      );
  }
}

function iconPill(selected: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: "10px 12px",
    borderRadius: 999,
    border: `1px solid ${adminColors.border}`,
    background: selected ? "rgba(15,23,42,0.92)" : "#fff",
    color: selected ? "#fff" : adminColors.text,
    cursor: "pointer",
    fontWeight: 900,
    lineHeight: 1,
    boxShadow: selected ? "0 10px 20px rgba(15,23,42,0.12)" : "none",
    minWidth: 42,
    height: 42,
  };
}

type DKey = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";

function dayKeyFromDate(d: Date): DKey {
  const idx = d.getDay();
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][idx] as DKey;
}

type WorkingHours = Record<DKey, { open: string; close: string; closed: boolean }>;

function defaultHours(): WorkingHours {
  return {
    sun: { open: "08:00", close: "22:00", closed: false },
    mon: { open: "08:00", close: "22:00", closed: false },
    tue: { open: "08:00", close: "22:00", closed: false },
    wed: { open: "08:00", close: "22:00", closed: false },
    thu: { open: "08:00", close: "22:00", closed: false },
    fri: { open: "08:00", close: "22:00", closed: false },
    sat: { open: "08:00", close: "22:00", closed: false },
  };
}

// The backend may return tenant hours as an array of rows:
//   { hours: [{ day_of_week, open_time, close_time, is_closed }, ...] }
// but the owner UI expects a WorkingHours map keyed by sun..sat.
function normalizeWorkingHoursFromApi(hoursJson: any): WorkingHours {
  const maybe = hoursJson?.workingHours ?? hoursJson?.hours ?? null;

  // Already in the correct map shape
  if (maybe && !Array.isArray(maybe) && typeof maybe === "object") {
    return maybe as WorkingHours;
  }

  // Array -> map
  if (Array.isArray(maybe)) {
    const base = defaultHours();

    for (const row of maybe) {
      const dowRaw = row?.day_of_week;
      const dow = String(dowRaw ?? "").toLowerCase().trim();

      const key: DKey | null =
        dow === "0" || dow === "sun" || dow === "sunday"
          ? "sun"
          : dow === "1" || dow === "mon" || dow === "monday"
          ? "mon"
          : dow === "2" || dow === "tue" || dow === "tuesday"
          ? "tue"
          : dow === "3" || dow === "wed" || dow === "wednesday"
          ? "wed"
          : dow === "4" || dow === "thu" || dow === "thursday"
          ? "thu"
          : dow === "5" || dow === "fri" || dow === "friday"
          ? "fri"
          : dow === "6" || dow === "sat" || dow === "saturday"
          ? "sat"
          : null;

      if (!key) continue;

      base[key] = {
        open: String(row?.open_time ?? base[key].open),
        close: String(row?.close_time ?? base[key].close),
        closed: Boolean(row?.is_closed ?? false),
      };
    }

    return base;
  }

  return defaultHours();
}

function addMinutesISO(iso: string, minutes: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  d.setMinutes(d.getMinutes() + minutes);
  return d.toISOString();
}

function normalizeBooking(raw: any): BookingRow {
  const start_time = String(raw?.start_time ?? raw?.starts_at ?? "");
  const duration_minutes = Number(raw?.duration_minutes ?? 0);

  const starts_at = String(raw?.starts_at ?? start_time);
  const ends_at = String(
    raw?.ends_at ??
      (starts_at ? addMinutesISO(starts_at, duration_minutes) : "")
  );

  return {
    ...raw,
    start_time,
    duration_minutes,
    starts_at: starts_at || start_time,
    ends_at: ends_at || (start_time ? addMinutesISO(start_time, duration_minutes) : ""),
  } as BookingRow;
}

function parseTimeToMinutes(input: any, fallbackMinutes: number): number {
  if (typeof input !== "string") return fallbackMinutes;

  const s = input.trim().toLowerCase();

  // Accept common midnight variants
  if (s === "00:00" || s === "0:00" || s === "24:00" || s === "12:00 am") return 0;

  // AM/PM formats like "10:00 pm"
  const ampm = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (ampm) {
    let h = Number(ampm[1]);
    const m = Number(ampm[2] ?? "0");
    const ap = ampm[3];
    if (!Number.isFinite(h) || !Number.isFinite(m)) return fallbackMinutes;
    h = h % 12;
    if (ap === "pm") h += 12;
    return h * 60 + m;
  }

  // "HH:MM"
  const parts = s.split(":");
  if (parts.length >= 2) {
    const h = Number(parts[0]);
    const m = Number(parts[1]);
    if (Number.isFinite(h) && Number.isFinite(m)) return h * 60 + m;
  }

  return fallbackMinutes;
}

function getDayViewHours(
  dayViewDate: string,
  workingHours: WorkingHours,
  stepMinutes: number
): number[] {
  const d = new Date(`${dayViewDate}T00:00:00`);
  const key = dayKeyFromDate(d);

  const cfg = workingHours?.[key];
  if (!cfg || cfg.closed) return [];

  const openStr = cfg.open ?? "08:00";
  const closeStr = cfg.close ?? "22:00";

  const start = parseTimeToMinutes(openStr, 8 * 60);

  // If close is midnight, treat it as "end of day" for Day View
  const closeTrim = String(closeStr).trim().toLowerCase();
  const closeIsMidnight =
    closeTrim === "00:00" || 
    closeTrim === "0:00" || 
    closeTrim === "24:00" || 
    closeTrim === "12:00 am" || 
    closeTrim === "12:00 a.m.";

  let end = closeIsMidnight ? 24 * 60 : parseTimeToMinutes(closeStr, 22 * 60);

  // Safety: if end <= start, assume it means "until end of day"
  if (end <= start) end = 24 * 60;

  // Generate slots (minutes-from-midnight) using the desired grid interval.
  const step = Number.isFinite(stepMinutes) && stepMinutes > 0 ? stepMinutes : 60;

  // Align to step boundary so the grid lines are consistent.
  const first = Math.ceil(start / step) * step;
  const hours: number[] = [];
  for (let t = first; t < end; t += step) hours.push(t);

  return hours;
}

type Tenant = {
  id: number;
  slug: string;
  name: string;
  kind?: string | null;
  timezone?: string | null;
  allow_pending?: boolean | null;
  currency_code?: string | null;
  logo_url?: string | null;
  cover_image_url?: string | null;
  logo_key?: string | null;
  cover_image_key?: string | null;
  banner_home_url?: string | null;
  banner_home_key?: string | null;
  banner_book_url?: string | null;
  banner_book_key?: string | null;
  banner_reservations_url?: string | null;
  banner_reservations_key?: string | null;
  banner_account_url?: string | null;
  banner_account_key?: string | null;
  branding?: any;
  theme_key?: string | null;
  brand_overrides_json?: any;
};

type Service = {
  id: number;
  name: string;
  description?: string | null;
  duration_minutes: number;
  is_active: boolean;
  requires_staff: boolean;
  requires_resource: boolean;
  slot_interval_minutes?: number | null;
  max_parallel_bookings?: number | null;
  max_consecutive_slots?: number | null;
  availability_basis?: "auth" | "none" | null;
  price_amount?: number | null;
  image_url?: string | null;
};

type Staff = {
  id: number;
  name: string;
  role?: string | null;
  is_active: boolean;
  photo_url?: string | null;
  avatar_url?: string | null;
  image_url?: string | null;
};

type Resource = {
  id: number;
  name: string;
  type?: string | null;
  is_active: boolean;
  photo_url?: string | null;
  image_url?: string | null;
};

type Customer = {
  id: number;
  name: string;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type OwnerTenantPageMode = "full" | "setup-only";

export default function OwnerTenantPageClient({
  slug,
  mode = "full",
  setupSection,
}: {
  slug: string;
  mode?: OwnerTenantPageMode;
  setupSection?: SetupSectionKey;
}) {
  const router = useRouter();

  const PAGE_SIZE = 25;

  // global load state
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // tabs
  const [activeTab, setActiveTab] = useState<
    | "dashboard"
    | "bookings"
    | "add"
    | "setup"
    | "dayview"
    | "customers"
    | "appearance"
    | "staffSchedule"
  >("dashboard");

  // right-side drawer navigation (mirrors Premium theme interaction)
  const [navOpen, setNavOpen] = useState(false);

  // optional deep-linking: /owner/[slug]?tab=setup&pill=services
  const [initialSetupPill, setInitialSetupPill] = useState<
    | "hours"
    | "services"
    | "staff"
    | "resources"
    | "images"
    | "appearance"
    | "blackouts"
    | "memberships"
    | "plans"
    | undefined
  >(undefined);

  useEffect(() => {
    if (mode !== "full") return;
    if (typeof window === "undefined") return;

    const sp = new URLSearchParams(window.location.search);
    const t = (sp.get("tab") || "").toLowerCase();

    const allowedTabs = new Set([
      "dashboard",
      "bookings",
      "add",
      "setup",
      "dayview",
      "customers",
      "appearance",
      "staffschedule",
      "staffSchedule",
    ]);

    const pillRaw = (sp.get("pill") || "").toLowerCase();
    // Back-compat: old deep links
    const pill = pillRaw === "brand" || pillRaw === "theme" ? "appearance" : pillRaw;
    const allowedPills = new Set([
      "hours",
      "services",
      "staff",
      "resources",
      "images",
      "appearance",
      "blackouts",
      "memberships",
      "plans",
    ]);
    const normalizedPill = (pill && allowedPills.has(pill) ? pill : "hours") as any;

    // If the caller requested the legacy "setup" tab, redirect into the new Setup workspace.
    if (t === "setup") {
      router.replace(`/owner/${encodeURIComponent(slug)}/setup/${encodeURIComponent(normalizedPill)}`);
      return;
    }

    if (t && allowedTabs.has(t)) setActiveTab(t as any);

    if (pill && allowedPills.has(pill)) setInitialSetupPill(pill as any);
  }, [slug, mode, router]);

  // day view
  const [dayViewDate, setDayViewDate] = useState<string>(() => formatLocalDate(new Date()));
  const [timeMode, setTimeMode] = useState<TimeMode>("day");
  const [dayViewBookings, setDayViewBookings] = useState<BookingRow[]>([]);
  const [dayViewLoading, setDayViewLoading] = useState(false);
  const [dayViewError, setDayViewError] = useState<string | null>(null);

  // KPI counts (lightweight)
  const [kpiCounts, setKpiCounts] = useState<{ today: number; upcoming: number; all: number }>({
    today: 0,
    upcoming: 0,
    all: 0,
  });
  const [kpiCountsLoading, setKpiCountsLoading] = useState(false);

  // core data
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [services, setServices] = useState<Service[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);

  // ---------------------------------------------------------------------------
  // Theme Studio (tenant-scoped): Theme dictates layout (A) + Dashboard-driven controls (C)
  // ---------------------------------------------------------------------------
  const [appearanceMessage, setAppearanceMessage] = useState<string | null>(null);
  const [appearanceSaving, setAppearanceSaving] = useState(false);

  const [selectedThemeKey, setSelectedThemeKey] = useState<string>("");
  const [brandingDraft, setBrandingDraft] = useState<any>(null);
  const [brandingPublished, setBrandingPublished] = useState<any>(null);
  const [themeStudioDraft, setThemeStudioDraft] = useState<Record<string, string>>({});

  const [publishMeta, setPublishMeta] = useState<any>(null);
  const [publishLoading, setPublishLoading] = useState(false);
  const [publishActionLoading, setPublishActionLoading] = useState(false);
  const [confirmRevertBrandingOpen, setConfirmRevertBrandingOpen] = useState(false);
  const [confirmRevertBusy, setConfirmRevertBusy] = useState(false);

  useEffect(() => {
    if (!tenant) return;
    setSelectedThemeKey(String((tenant as any)?.theme_key || ""));
    setBrandingDraft(structuredClone((tenant as any)?.branding || {}));
    setThemeStudioDraft(structuredClone((tenant as any)?.brand_overrides_json || {}));
  }, [tenant?.id]);

  const hasUnpublishedBrandingChanges = useMemo(() => {
    if (!brandingDraft) return false;
    // If no published snapshot exists yet, treat any non-empty draft as "unpublished".
    if (!brandingPublished) return Object.keys(brandingDraft || {}).length > 0;
    return !deepEqual(brandingDraft, brandingPublished);
  }, [brandingDraft, brandingPublished]);

  const hasPublishedSnapshot = useMemo(() => {
    return Boolean(brandingPublished && typeof brandingPublished === "object" && Object.keys(brandingPublished).length > 0);
  }, [brandingPublished]);

  async function refreshPublishStatus() {
    if (!slug) return;
    setPublishLoading(true);
    try {
      const res = await fetch(`${OWNER_API}/tenant/${encodeURIComponent(slug)}/publish-status`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`Publish status failed (${res.status}) ${txt}`);
      }
      const data = await res.json();
      setPublishMeta(data);
      const pub = data?.snapshots?.branding_published;
      setBrandingPublished(structuredClone(pub && typeof pub === "object" ? pub : {}));
    } catch (e: any) {
      // Non-fatal: the rest of the page can still work.
      setPublishMeta({ error: e?.message || "Failed to load publish status." });
      setBrandingPublished(null);
    } finally {
      setPublishLoading(false);
    }
  }

  useEffect(() => {
    if (!slug) return;
    refreshPublishStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, tenant?.id]);

  async function publishTenantSnapshot() {
    if (!slug) return;
    setPublishActionLoading(true);
    setAppearanceMessage(null);
    try {
      const res = await fetch(`${OWNER_API}/tenants/publish?tenantSlug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      // 409 is expected when blocked
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        const msg = payload?.error || payload?.message || `Publish blocked (${res.status})`;
        // Show first blocking reason if present
        const first = Array.isArray(payload?.errors) && payload.errors.length ? payload.errors[0]?.message : null;
        throw new Error(first || msg);
      }

      setAppearanceMessage("Published (live booking page updated).");
      await refreshPublishStatus();
    } catch (e: any) {
      setAppearanceMessage(e?.message || "Failed to publish.");
      await refreshPublishStatus();
    } finally {
      setPublishActionLoading(false);
    }
  }

  async function revertDraftToPublished() {
    if (!hasPublishedSnapshot) return;
    setConfirmRevertBrandingOpen(true);
  }

  async function performRevertDraftToPublished() {
    if (!hasPublishedSnapshot) return;
    setConfirmRevertBusy(true);
    try {
      const next = structuredClone(brandingPublished || {});
      setBrandingDraft(next);
      await saveTenantBrandingPatch({ branding: next });
      await refreshPublishStatus();
    } finally {
      setConfirmRevertBusy(false);
      setConfirmRevertBrandingOpen(false);
    }
  }

  async function saveTenantThemeKey(nextThemeKey: string) {
    if (!tenant?.id) return;
    setAppearanceSaving(true);
    setAppearanceMessage(null);
    try {
      const r = await setTenantThemeKey({ apiBase: OWNER_API, tenantId: tenant.id, themeKey: nextThemeKey });
      if (!r.ok) throw new Error(r.error);
      setTenant((prev) => (prev ? ({ ...(prev as any), theme_key: nextThemeKey } as any) : prev));
      setAppearanceMessage("Theme published.");
    } catch (e: any) {
      setAppearanceMessage(e?.message || "Failed to publish theme.");
    } finally {
      setAppearanceSaving(false);
    }
  }


  async function saveTenantBrandingPatch(patch: any) {
    if (!tenant?.id) return;
    setAppearanceSaving(true);
    setAppearanceMessage(null);
    try {
      const res = await fetch(`${OWNER_API}/tenants/${tenant.id}/branding`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patch }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`Branding save failed (${res.status}) ${txt}`);
      }
      // optimistic local update
      if (patch?.branding) {
        setTenant((prev) => (prev ? ({ ...(prev as any), branding: patch.branding } as any) : prev));
      }
      if (patch?.brand_overrides) {
        setTenant((prev) => (prev ? ({ ...(prev as any), brand_overrides_json: patch.brand_overrides } as any) : prev));
      }
      setAppearanceMessage("Saved.");
    } catch (e: any) {
      setAppearanceMessage(e?.message || "Failed to save.");
    } finally {
      setAppearanceSaving(false);
    }
  }

  // Tenant-level feature flag: allow "pending" booking status.
  // Default is true unless the backend explicitly returns allow_pending=false.
  const allowPending = (tenant as any)?.allow_pending !== false;

  // setup (all sections shown via OwnerSetupTab)
  const [workingHours, setWorkingHours] = useState<WorkingHours>(defaultHours());

  

  

  const handleWorkingHoursChange = (
    day: "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun",
    field: "open" | "close" | "closed",
    value: string | boolean
  ) => {
    setWorkingHours((prev) => ({
      ...prev,
      [day]: {
        ...(prev as any)[day],
        [field]: value as any,
      },
    }) as any);
  };
  // ✅ local UI state used by setup + mutations
  const [setupMessage, setSetupMessage] = useState<string | null>(null);
  const [savingWorkingHours, setSavingWorkingHours] = useState(false);
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  
  // bookings list (paginated/filter)
  const [bookings, setBookings] = useState<BookingRow[]>([]);
  const [bookingsLoading, setBookingsLoading] = useState(false);
  const [bookingsError, setBookingsError] = useState<string | null>(null);
  const [bookingsNextCursor, setBookingsNextCursor] = useState<{ start_time?: string; created_at?: string; id: number } | null>(null);
  
  // row → modal details
  const [selectedBooking, setSelectedBooking] = useState<BookingRow | null>(null);
  const [hoverBookingId, setHoverBookingId] = useState<number | null>(null);

  // keep modal in sync if list refreshes / status updates
  useEffect(() => {
    if (!selectedBooking) return;
    const latest = bookings.find((b) => b.id === selectedBooking.id);
    if (latest && latest !== selectedBooking) setSelectedBooking(latest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookings]);

  // filters
  const [view, setView] = useState<"upcoming" | "past" | "all" | "latest">("upcoming");
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");
  const [status, setStatus] = useState<string>("all");
  const [query, setQuery] = useState<string>("");
  const [filterServiceId, setFilterServiceId] = useState<number | "">("");
  const [filterStaffId, setFilterStaffId] = useState<number | "">("");
  const [filterResourceId, setFilterResourceId] = useState<number | "">("");
  const [filterCustomerId, setFilterCustomerId] = useState<number | "">("");

  // create booking (manual)
  const [addCustomerId, setAddCustomerId] = useState<number | "">("");
  const [addCustomerSuggestOpen, setAddCustomerSuggestOpen] = useState(false);
  const [addCustomerName, setAddCustomerName] = useState("");
  const [addCustomerPhone, setAddCustomerPhone] = useState("");
  const [addCustomerEmail, setAddCustomerEmail] = useState("");
  const [addServiceId, setAddServiceId] = useState<number | "">("");
  const [addStaffId, setAddStaffId] = useState<number | "">("");
  const [addResourceId, setAddResourceId] = useState<number | "">("");
  const [addStartTime, setAddStartTime] = useState("");
  const [addDuration, setAddDuration] = useState<number>(60);
  const [addStatus, setAddStatus] = useState<string>("confirmed");
  const [addUseMembershipCredits, setAddUseMembershipCredits] = useState<boolean>(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addSaving, setAddSaving] = useState(false);

  // service editor
  const [svcEditId, setSvcEditId] = useState<number | null>(null);
  const [svcName, setSvcName] = useState("");
  const [svcDuration, setSvcDuration] = useState("60");
  const [svcPrice, setSvcPrice] = useState("0");
  const [svcReqStaff, setSvcReqStaff] = useState(false);
  const [svcReqRes, setSvcReqRes] = useState(false);
  const [svcRequiresConfirmation, setSvcRequiresConfirmation] = useState(false);
  const [svcInterval, setSvcInterval] = useState("60");
  const [svcMaxSlots, setSvcMaxSlots] = useState("4");
  const [svcParallel, setSvcParallel] = useState("1");
  const [svcSaving, setSvcSaving] = useState(false);
  const [svcError, setSvcError] = useState<string | null>(null);

  const [staffName, setStaffName] = useState("");
  const [staffRole, setStaffRole] = useState("");
  const [staffSaving, setStaffSaving] = useState(false);
  const [staffError, setStaffError] = useState<string | null>(null);

  const [resName, setResName] = useState("");
  const [resType, setResType] = useState("");
  const [resSaving, setResSaving] = useState(false);
  const [resError, setResError] = useState<string | null>(null);

  

  // owner mutations (reused)
  const {
    handleSaveWorkingHours,
    handleLogoChange,
    handleLogoFileChange,
    handleEntityImageChange,
    handleEntityImageDelete,

    handleCreateService,
    handleCreateStaff,
    handleCreateResource,

    handleDeleteService,
    handleDeleteStaff,
    handleDeleteResource,

    handleUpdateServiceAvailabilityBasis,
    handlePatchService,
  } = useOwnerMutations({
    slug,

    tenant: tenant as any,
    setTenant: setTenant as any,
    setServices: setServices as any,
    setStaff: setStaff as any,
    setResources: setResources as any,

    workingHours: workingHours as any,
    setSetupMessage,
    setSavingWorkingHours,

    setLogoError,
    setLogoUploading,

    svcName,
    setSvcName,
    svcDuration,
    setSvcDuration,
    svcPrice,
    setSvcPrice,
    svcReqStaff,
    setSvcReqStaff,
    svcReqRes,
    setSvcReqRes,
    svcRequiresConfirmation,
    setSvcRequiresConfirmation,
    svcInterval,
    setSvcInterval,
    svcMaxSlots,
    setSvcMaxSlots,
    svcParallel,
    setSvcParallel,

    staffName,
    setStaffName,
    staffRole,
    setStaffRole,

    resName,
    setResName,
    resType,
    setResType,
  });
const currency = tenant?.currency_code || "USD";

  // ---------------------------------------------------------------------------
  // Load tenant + core lists
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!slug) return;

    let cancelled = false;

    (async () => {
      try {
        setLoading(true);
        setError(null);

        // NOTE (protocol): prefer targeted tenant fetch over loading ALL tenants.
        // This keeps payloads consistent (logo/banner fields won't 'disappear') and scales better.
        const tenantRes = await fetch(`${OWNER_API}/tenants/by-slug/${encodeURIComponent(slug)}`);
        const tenantJson = await tenantRes.json().catch(() => ({}));
        if (!tenantRes.ok) throw new Error(tenantJson.error || `Tenant not found: ${slug}`);

        const found: Tenant | null = tenantJson.tenant || null;
        if (!found) throw new Error(`Tenant not found: ${slug}`);

        if (cancelled) return;
        setTenant(found);

        const [svcRes, staffRes, resRes, custRes, hoursRes] = await Promise.all([
          fetch(`${OWNER_API}/services?tenantSlug=${encodeURIComponent(slug)}`),
          fetch(`${OWNER_API}/staff?tenantSlug=${encodeURIComponent(slug)}`),
          fetch(`${OWNER_API}/resources?tenantSlug=${encodeURIComponent(slug)}`),
          fetch(`${OWNER_API}/customers?tenantSlug=${encodeURIComponent(slug)}`),
          fetch(`${OWNER_API}/tenant-hours?tenantSlug=${encodeURIComponent(slug)}`),
        ]);

        const svcJson = await svcRes.json().catch(() => ({}));
        const staffJson = await staffRes.json().catch(() => ({}));
        const resJson = await resRes.json().catch(() => ({}));
        const custJson = await custRes.json().catch(() => ({}));
        const hoursJson = await hoursRes.json().catch(() => ({}));

        if (!svcRes.ok) throw new Error(svcJson.error || "Failed to load services");
        if (!staffRes.ok) throw new Error(staffJson.error || "Failed to load staff");
        if (!resRes.ok) throw new Error(resJson.error || "Failed to load resources");
        if (!custRes.ok) throw new Error(custJson.error || "Failed to load customers");

        if (!hoursRes.ok) {
          // hours are optional
          setWorkingHours(defaultHours());
        } else {
          setWorkingHours(normalizeWorkingHoursFromApi(hoursJson));
        }

        if (cancelled) return;
        setServices(Array.isArray(svcJson) ? svcJson : (svcJson.services || []));
        setStaff(staffJson.staff || []);
        setResources(resJson.resources || []);
        setCustomers(custJson.customers || []);
      } catch (e: any) {
        if (!cancelled) setError(e.message || "Failed to load tenant data.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [slug]);

  // ---------------------------------------------------------------------------
  // Booking list fetch (cursor pagination)
  // ---------------------------------------------------------------------------
  async function fetchBookings(
    cursor: { start_time?: string; created_at?: string; id: number } | null,
    mode: "replace" | "append"
  ) {
    if (!slug) return;

    setBookingsLoading(true);
    setBookingsError(null);

    try {
      const url = new URL(`${OWNER_API}/bookings`, window.location.origin);
      url.searchParams.set("tenantSlug", slug);

      // Map UI "view" to backend "scope" (latest orders by created_at DESC)
      url.searchParams.set("scope", view);
      url.searchParams.set("limit", String(PAGE_SIZE));

      if (cursor) {
        if (cursor.start_time) url.searchParams.set("cursorStartTime", cursor.start_time);
        if (cursor.created_at) url.searchParams.set("cursorCreatedAt", cursor.created_at);
        url.searchParams.set("cursorId", String(cursor.id));
      }

      if (fromDate) url.searchParams.set("from", fromDate);
      if (toDate) url.searchParams.set("to", toDate);
      if (status && status !== "all") url.searchParams.set("status", status);
      if (query.trim()) url.searchParams.set("query", query.trim());
      if (filterServiceId !== "") url.searchParams.set("serviceId", String(filterServiceId));
      if (filterStaffId !== "") url.searchParams.set("staffId", String(filterStaffId));
      if (filterResourceId !== "") url.searchParams.set("resourceId", String(filterResourceId));
      if (filterCustomerId !== "") url.searchParams.set("customerId", String(filterCustomerId));

      const res = await fetch(url.toString());
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load bookings");

      const rows: BookingRow[] = (json.bookings || []).map(normalizeBooking);
      const next = json.nextCursor || null;

      setBookings((prev) => (mode === "replace" ? rows : [...prev, ...rows]));
      setBookingsNextCursor(next);
    } catch (e: any) {
      setBookingsError(e.message || "Failed to load bookings.");
      if (mode === "replace") setBookings([]);
      setBookingsNextCursor(null);
    } finally {
      setBookingsLoading(false);
    }
  }

  async function fetchBookingCount(opts: {
    scope: "upcoming" | "past" | "all" | "range";
    from?: string;
    to?: string;
  }): Promise<number> {
    const url = new URL(`${OWNER_API}/bookings/count`, window.location.origin);
    url.searchParams.set("tenantSlug", slug);
    url.searchParams.set("scope", opts.scope);
    if (opts.from) url.searchParams.set("from", opts.from);
    if (opts.to) url.searchParams.set("to", opts.to);

    const res = await fetch(url.toString());
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || "Failed to load booking count");
    // Backend returns { total }, older clients may have used { count }.
    return Number(json.total ?? json.count ?? 0);
  }

  useEffect(() => {
    if (!slug) return;

    let cancelled = false;
    (async () => {
      try {
        setKpiCountsLoading(true);

        const { fromIso, toIso } = dayRangeIso(dayViewDate);
        const [today, upcoming, all] = await Promise.all([
          fetchBookingCount({ scope: "range", from: fromIso, to: toIso }),
          fetchBookingCount({ scope: "upcoming" }),
          fetchBookingCount({ scope: "all" }),
        ]);

        if (!cancelled) setKpiCounts({ today, upcoming, all });
      } catch {
        if (!cancelled) setKpiCounts({ today: 0, upcoming: 0, all: 0 });
      } finally {
        if (!cancelled) setKpiCountsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [slug, dayViewDate]);

// ---------------------------------------------------------------------
// Heartbeat "nudge" polling (cheap): every 10s while on Day View or Bookings.
// If backend marker changes, refresh the relevant data.
// ---------------------------------------------------------------------
const lastHeartbeatRef = useRef<string | null>(null);
const lastRefreshMsRef = useRef<number>(0);

useEffect(() => {
  if (!slug) return;

  const shouldPoll = () =>
    (activeTab === "dayview" || activeTab === "bookings") &&
    typeof document !== "undefined" &&
    document.visibilityState === "visible";

  let stopped = false;
  let timer: any = null;
  let inFlight = false;

  const tick = async () => {
    if (stopped) return;
    if (!shouldPoll()) return;
    if (inFlight) return;
    inFlight = true;

    try {
      const res = await fetch(
        `${OWNER_API}/tenants/heartbeat?tenantSlug=${encodeURIComponent(slug)}`,
        { cache: "no-store" as any }
      );
      if (!res.ok) return;
      const json = await res.json();
      const marker = String(json?.lastBookingChangeAt || "");
      if (!marker) return;

      if (lastHeartbeatRef.current == null) {
        lastHeartbeatRef.current = marker;

        // Initial sync: when owner opens Day View / Bookings, refresh once even if marker is "new" to this tab.
        const now0 = Date.now();
        if (now0 - lastRefreshMsRef.current >= 1500) {
          lastRefreshMsRef.current = now0;
          if (activeTab === "dayview") {
            refreshDayViewBookings(dayViewDate);
          } else if (activeTab === "bookings") {
            fetchBookings(null, "replace");
          }
        }

        return;
      }

      if (marker !== lastHeartbeatRef.current) {
        lastHeartbeatRef.current = marker;

        // debounce refresh storms
        const now = Date.now();
        if (now - lastRefreshMsRef.current < 1500) return;
        lastRefreshMsRef.current = now;

        if (activeTab === "dayview") {
          void refreshDayViewBookings(dayViewDate);
        } else if (activeTab === "bookings") {
          void fetchBookings(null, "replace");
        }
      }
    } catch {
      // ignore
    } finally {
      inFlight = false;
    }
  };

  // start
  void tick();
  timer = setInterval(tick, 10000);

  const onFocus = () => void tick();
  const onVis = () => void tick();
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVis);

  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVis);
  };
  // IMPORTANT: include booking filter state so the interval callback always
  // refreshes the *currently selected* bookings scope (upcoming/latest/past/all)
  // and doesn’t fall back to the initial default via a stale closure.
}, [
  slug,
  activeTab,
  dayViewDate,
  view,
  fromDate,
  toDate,
  status,
  query,
  filterServiceId,
  filterStaffId,
  filterResourceId,
  filterCustomerId,
]);



  // ---------------------------------------------------------------------------
  // Day view bookings (separate lightweight fetch scoped to a single date)
  // ---------------------------------------------------------------------------
  function dayRangeIso(dateStr: string): { fromIso: string; toIso: string } {
    const start = new Date(`${dateStr}T00:00:00`);
    const end = new Date(`${dateStr}T00:00:00`);
    end.setDate(end.getDate() + 1);
    return { fromIso: start.toISOString(), toIso: end.toISOString() };
  }

  async function refreshDayViewBookings(dateStr: string) {
    if (!slug) return;

    setDayViewLoading(true);
    setDayViewError(null);

    try {
      const { fromIso, toIso } = dayRangeIso(dateStr);
      const url = new URL(`${OWNER_API}/bookings`, window.location.origin);
      url.searchParams.set("tenantSlug", slug);
      url.searchParams.set("scope", "range");
      url.searchParams.set("from", fromIso);
      url.searchParams.set("to", toIso);
      url.searchParams.set("limit", "200");

      const res = await fetch(url.toString());
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load day view bookings");

      setDayViewBookings((json.bookings || []).map(normalizeBooking));
    } catch (e: any) {
      setDayViewError(e.message || "Failed to load day view.");
      setDayViewBookings([]);
    } finally {
      setDayViewLoading(false);
    }
  }

  useEffect(() => {
    refreshDayViewBookings(dayViewDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, dayViewDate]);

  // ---------------------------------------------------------------------------
  // First load bookings list
  // ---------------------------------------------------------------------------
  useEffect(() => {
    fetchBookings(null, "replace");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, view]);

  // ---------------------------------------------------------------------------
  // Booking actions
  // ---------------------------------------------------------------------------
  async function updateBookingStatus(id: number, newStatus: string) {
    const res = await fetch(`${OWNER_API}/bookings/${id}/status?tenantSlug=${encodeURIComponent(slug)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus }),
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || "Failed to update status");

    const updatedRaw = (json.booking || json.updated || null) as any;
    if (updatedRaw) {
      const updated = normalizeBooking(updatedRaw);
      setBookings((prev) => prev.map((b) => (b.id === updated.id ? updated : b)));
      setDayViewBookings((prev) => prev.map((b) => (b.id === updated.id ? updated : b)));
      setSelectedBooking((prev) => (prev && prev.id === updated.id ? updated : prev));
    }
  }

  // ---------------------------------------------------------------------------
  // Create booking
  // ---------------------------------------------------------------------------
  const createBookingIdemKeyRef = useRef<string>("");

  function randomIdemKey() {
    return `idem_${Math.random().toString(16).slice(2)}_${Date.now()}`;
  }

  async function createBooking() {
    if (!slug) return;

    setAddError(null);
    setAddSaving(true);

    try {
      if (!addCustomerName.trim()) throw new Error("Customer name is required.");
      if (!addServiceId) throw new Error("Select a service.");
      if (!addStartTime) throw new Error("Pick a start time.");

      // Membership credits (money-trust feature)
      // Manual bookings can only consume membership credits for an EXISTING customer.
      // (A new customer cannot have a membership yet.)
      if (addUseMembershipCredits && !addCustomerId) {
        throw new Error("To use membership credits, select an existing customer first.");
      }

      const idemKey = createBookingIdemKeyRef.current || randomIdemKey();
      createBookingIdemKeyRef.current = idemKey;

      // IMPORTANT: datetime-local values have NO timezone.
      // If we send them raw, the backend server (often UTC) interprets them as UTC → shifts local time.
      // Normalize to an absolute instant (UTC ISO string) before sending.
      const startTimeIso = new Date(addStartTime).toISOString();

      // Backend expects camelCase fields (serviceId, startTime, durationMinutes, customerName...)
      const body: any = {
        tenantSlug: slug,
        serviceId: addServiceId,
        startTime: startTimeIso,
        durationMinutes: addDuration,
        customerName: addCustomerName.trim(),
        customerPhone: addCustomerPhone.trim() || null,
        customerEmail: addCustomerEmail.trim() || null,
      };
      if (addCustomerId) body.customerId = addCustomerId;
      if (addStaffId) body.staffId = addStaffId;
      if (addResourceId) body.resourceId = addResourceId;

      // Membership consumption (Phase 2 closure): mirrors public booking flow
      if (addUseMembershipCredits) {
        body.autoConsumeMembership = true;
        body.requireMembership = true;
      }

      const res = await fetch(`${OWNER_API}/bookings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idemKey,
        },
        body: JSON.stringify(body),
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to create booking");

      createBookingIdemKeyRef.current = "";

      fetchBookings(null, "replace");
      refreshDayViewBookings(dayViewDate);

      setAddCustomerName("");
      setAddCustomerPhone("");
      setAddCustomerEmail("");
      setAddCustomerId("");
      setAddServiceId("");
      setAddStaffId("");
      setAddResourceId("");
      setAddStartTime("");
      setAddDuration(60);
      setAddStatus("pending");
      setAddUseMembershipCredits(false);

      setActiveTab("bookings");
    } catch (e: any) {
      setAddError(e.message || "Failed to create booking.");
    } finally {
      setAddSaving(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Service / staff / resource simple CRUD (used in setup tab too)
  // ---------------------------------------------------------------------------
  async function reloadCatalog() {
    const [svcRes, staffRes, resRes, custRes] = await Promise.all([
      fetch(`${OWNER_API}/services?tenantSlug=${encodeURIComponent(slug)}`),
      fetch(`${OWNER_API}/staff?tenantSlug=${encodeURIComponent(slug)}`),
      fetch(`${OWNER_API}/resources?tenantSlug=${encodeURIComponent(slug)}`),
      fetch(`${OWNER_API}/customers?tenantSlug=${encodeURIComponent(slug)}`),
    ]);

    const svcJson = await svcRes.json().catch(() => ({}));
    const staffJson = await staffRes.json().catch(() => ({}));
    const resJson = await resRes.json().catch(() => ({}));
    const custJson = await custRes.json().catch(() => ({}));

    if (svcRes.ok) setServices(Array.isArray(svcJson) ? svcJson : (svcJson.services || []));
    if (staffRes.ok) setStaff(staffJson.staff || []);
    if (resRes.ok) setResources(resJson.resources || []);
    if (custRes.ok) setCustomers(custJson.customers || []);
  }

  function resetServiceForm() {
    setSvcEditId(null);
    setSvcName("");
    setSvcDuration("60");
    setSvcPrice("0");
    setSvcReqStaff(false);
    setSvcReqRes(false);
    setSvcInterval("60");
    setSvcMaxSlots("4");
    setSvcParallel("1");
  }

  function startEditService(s: Service) {
    setSvcEditId(s.id);
    setSvcName(s.name || "");
    setSvcDuration(String(s.duration_minutes ?? 60));
    setSvcPrice(String(s.price_amount ?? 0));
    setSvcReqStaff(!!s.requires_staff);
    setSvcReqRes(!!s.requires_resource);
    setSvcInterval(String(s.slot_interval_minutes ?? 60));
    setSvcMaxSlots(String(s.max_consecutive_slots ?? 4));
    setSvcParallel(String(s.max_parallel_bookings ?? 1));
  }

  async function saveService() {
    if (!slug) return;

    setSvcSaving(true);
    setSvcError(null);

    try {
      if (!svcName.trim()) throw new Error("Service name required.");

      const body: any = {
        tenantSlug: slug,
        name: svcName.trim(),
        duration_minutes: Number(svcDuration || 60),
        price_amount: Number(svcPrice || 0),
        requires_staff: !!svcReqStaff,
        requires_resource: !!svcReqRes,
        slot_interval_minutes: Number(svcInterval || 60),
        max_consecutive_slots: Number(svcMaxSlots || 4),
        max_parallel_bookings: Number(svcParallel || 1),
        is_active: true,
      };

      let res: Response;
      if (svcEditId) {
        res = await fetch(`${OWNER_API}/services/${svcEditId}?tenantSlug=${encodeURIComponent(slug)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        res = await fetch(`${OWNER_API}/services`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      }

      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to save service");

      await reloadCatalog();
      resetServiceForm();
    } catch (e: any) {
      setSvcError(e.message || "Failed.");
    } finally {
      setSvcSaving(false);
    }
  }

  async function saveStaff() {
    if (!slug) return;

    setStaffSaving(true);
    setStaffError(null);

    try {
      if (!staffName.trim()) throw new Error("Staff name required.");

      const body: any = {
        tenantSlug: slug,
        name: staffName.trim(),
        role: staffRole.trim() || null,
        is_active: true,
      };

      const res = await fetch(`${OWNER_API}/staff?tenantSlug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to add staff");

      setStaffName("");
      setStaffRole("");
      await reloadCatalog();
    } catch (e: any) {
      setStaffError(e.message || "Failed.");
    } finally {
      setStaffSaving(false);
    }
  }

  async function saveResource() {
    if (!slug) return;

    setResSaving(true);
    setResError(null);

    try {
      if (!resName.trim()) throw new Error("Resource name required.");

      const body: any = {
        tenantSlug: slug,
        name: resName.trim(),
        type: resType.trim() || null,
        is_active: true,
      };

      const res = await fetch(`${OWNER_API}/resources?tenantSlug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to add resource");

      setResName("");
      setResType("");
      await reloadCatalog();
    } catch (e: any) {
      setResError(e.message || "Failed.");
    } finally {
      setResSaving(false);
    }
  }

   // ---------------------------------------------------------------------------
  // Availability helpers
  // ---------------------------------------------------------------------------
  // Day View grid interval: use the smallest active service slot interval if present.
  // Falls back to 60 minutes (Birdie default).
  const dayViewStepMinutes = useMemo(() => {
    const ints = (services ?? [])
      .filter((s) => !!s && s.is_active)
      .map((s) => Number(s.slot_interval_minutes ?? 0))
      .filter((n) => Number.isFinite(n) && n > 0);
    return ints.length ? Math.min(...ints) : 60;
  }, [services]);

  const dayViewHours = useMemo(
    () => getDayViewHours(dayViewDate, workingHours, dayViewStepMinutes),
    [dayViewDate, workingHours, dayViewStepMinutes]
  );

  // ---------------------------------------------------------------------------
  // Manual booking: customer typeahead (local filter)
  // ---------------------------------------------------------------------------
  const addCustomerMatches = useMemo(() => {
    const q = String(addCustomerName || "").trim().toLowerCase();
    if (q.length < 2) return [] as Customer[];
    const scored = (customers || [])
      .map((c) => {
        const hay = `${c.name || ""} ${c.email || ""} ${c.phone || ""}`.toLowerCase();
        const hit = hay.includes(q);
        return { c, hit };
      })
      .filter((x) => x.hit)
      .map((x) => x.c);
    // Keep stable ordering: name first, then recent-ish by id.
    scored.sort((a, b) => {
      const an = (a.name || "").toLowerCase();
      const bn = (b.name || "").toLowerCase();
      if (an < bn) return -1;
      if (an > bn) return 1;
      return Number(b.id) - Number(a.id);
    });
    return scored.slice(0, 8);
  }, [addCustomerName, customers]);
  
  function findBookingForSlot(resourceId: number, hour: number): BookingRow | undefined {
    const slotStartMinutes = hour; // getDayViewHours returns minutes-from-midnight slots
  
    const slotStart = new Date(`${dayViewDate}T00:00:00`);
    slotStart.setMinutes(slotStartMinutes, 0, 0);
  
    const slotEnd = new Date(slotStart);
    slotEnd.setMinutes(slotEnd.getMinutes() + dayViewStepMinutes);
  
    return dayViewBookings.find((b) => {
      if ((b.resource_id ?? null) !== resourceId) return false;
  
      // Guard against missing/invalid start_time
      const st = new Date(b.start_time || "");
      if (Number.isNaN(st.getTime())) return false;
  
      const en = new Date(st);
      en.setMinutes(en.getMinutes() + (b.duration_minutes || 0));
  
      return st < slotEnd && en > slotStart;
    });
  }

  // ---------------------------------------------------------------------------
  // UI Styles
  // ---------------------------------------------------------------------------
  const pill = (active: boolean) => ({
    padding: "8px 12px",
    borderRadius: 999,
    border: active
      ? "1px solid var(--state-selected-border-strong, var(--text-primary, #0f172a))"
      : `1px solid ${adminColors.border}`,
    background: active
      ? "var(--state-selected-bg-strong, var(--text-primary, #0f172a))"
      : "var(--surface-panel, var(--surface-card, #ffffff))",
    color: active
      ? "var(--state-selected-text-strong, var(--text-inverse, #ffffff))"
      : adminColors.text,
    boxShadow: active ? "var(--shadow-selected, var(--shadow-md))" : "none",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 750 as const,
    letterSpacing: 0.2,
    transition: "transform var(--motion-interactive, 120ms) var(--ease-standard, ease), filter var(--motion-interactive, 120ms) var(--ease-standard, ease)",
  });

  if (loading) {
    if (mode === "setup-only") {
      return (
        <div style={{ padding: 16 }}>
          <div
            style={{
              borderRadius: adminRadii.card,
              border: `1px solid ${adminColors.border}`,
              background: adminColors.surfaceStrong,
              boxShadow: adminColors.shadowSoft,
              padding: 18,
              color: adminColors.text,
            }}
          >
            Loading tenant…
          </div>
        </div>
      );
    }
    return (
      <div style={{ minHeight: "100vh", backgroundImage: adminColors.pageBg, backgroundAttachment: "fixed" }}>
        <div style={{ padding: adminSpace.pagePad, maxWidth: 1200, margin: "0 auto", color: adminColors.text }}>
          <div
            style={{
              borderRadius: adminRadii.card,
              border: `1px solid ${adminColors.border}`,
              background: adminColors.surfaceStrong,
              boxShadow: adminColors.shadowSoft,
              padding: 18,
            }}
          >
            Loading tenant…
          </div>
        </div>
      </div>
    );
  }

  if (error || !tenant) {
    if (mode === "setup-only") {
      return (
        <div style={{ padding: 16 }}>
          <div
            style={{
              borderRadius: adminRadii.card,
              border: `1px solid ${adminColors.border}`,
              background: adminColors.surfaceStrong,
              boxShadow: adminColors.shadowSoft,
              padding: 18,
              color: adminColors.text,
            }}
          >
            <div style={{ fontWeight: 900, marginBottom: 8 }}>Couldn’t load tenant.</div>
            <div style={{ color: adminColors.muted }}>{error || "Unknown error"}</div>
            <div style={{ marginTop: 12 }}>
              <Link
                href="/owner/dashboard"
                style={{
                  padding: "10px 14px",
                  borderRadius: 999,
                  border: `1px solid ${adminColors.border}`,
                  background: adminColors.surfaceStrong,
                  color: adminColors.text,
                  fontWeight: 800,
                  textDecoration: "none",
                  display: "inline-flex",
                }}
              >
                ← Owner Dashboard
              </Link>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div style={{ minHeight: "100vh", backgroundImage: adminColors.pageBg, backgroundAttachment: "fixed" }}>
        <div style={{ padding: adminSpace.pagePad, maxWidth: 1200, margin: "0 auto", color: adminColors.text }}>
          <div
            style={{
              borderRadius: adminRadii.card,
              border: `1px solid ${adminColors.border}`,
              background: adminColors.surfaceStrong,
              boxShadow: adminColors.shadowSoft,
              padding: 18,
            }}
          >
            <div style={{ fontWeight: 900, marginBottom: 8 }}>Couldn’t load tenant.</div>
            <div style={{ color: adminColors.muted }}>{error || "Unknown error"}</div>
            <div style={{ marginTop: 0 }}>
              <Link
                href="/owner/dashboard"
                style={{
                  padding: "10px 14px",
                  borderRadius: 999,
                  border: `1px solid ${adminColors.border}`,
                  background: adminColors.surfaceStrong,
                  color: adminColors.text,
                  fontWeight: 800,
                  textDecoration: "none",
                }}
              >
                ← Owner Dashboard
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Setup-only workspace route: render only one setup section.
  if (mode === "setup-only") {
    const section = (setupSection || "hours") as any;
    return (
      <OwnerSetupTab
        mode="single"
        singlePill={section}
        tenantName={tenant.name}
        apiBase={OWNER_API}
        uploadBase={"/api/owner/proxy-upload"}
        initialPill={section}
        tenant={tenant as any}
        themeStudioDraft={themeStudioDraft}
        setThemeStudioDraft={setThemeStudioDraft}
        onSaveBrandOverrides={() => {
          void saveTenantBrandingPatch({ brand_overrides: themeStudioDraft || {} });
        }}
        onTenantUpdated={(t) => setTenant(t as any)}
        setupMessage={setupMessage}
        logoError={logoError}
        logoUploading={logoUploading}
        handleLogoFileChange={(e) => {
          void handleLogoFileChange(e);
        }}
        workingHours={workingHours as any}
        handleWorkingHoursChange={handleWorkingHoursChange as any}
        savingWorkingHours={savingWorkingHours}
        handleSaveWorkingHours={() => {
          void handleSaveWorkingHours();
        }}
        services={services as any}
        svcName={svcName}
        setSvcName={setSvcName}
        svcDuration={svcDuration}
        setSvcDuration={setSvcDuration}
        svcPrice={svcPrice}
        setSvcPrice={setSvcPrice}
        svcReqStaff={svcReqStaff}
        setSvcReqStaff={setSvcReqStaff}
        svcReqRes={svcReqRes}
        setSvcReqRes={setSvcReqRes}
        svcRequiresConfirmation={svcRequiresConfirmation}
        setSvcRequiresConfirmation={setSvcRequiresConfirmation}
        svcInterval={svcInterval}
        setSvcInterval={setSvcInterval}
        svcMaxSlots={svcMaxSlots}
        setSvcMaxSlots={setSvcMaxSlots}
        svcParallel={svcParallel}
        setSvcParallel={setSvcParallel}
        handleCreateService={(e) => {
          void handleCreateService(e);
        }}
        handleDeleteService={(id) => {
          void handleDeleteService(id);
        }}
        handleUpdateServiceAvailabilityBasis={(id, basis) => {
          void handleUpdateServiceAvailabilityBasis(id, basis);
        }}
        handlePatchService={(id, patch) => {
          void handlePatchService(id, patch);
        }}
        staff={staff as any}
        staffName={staffName}
        setStaffName={setStaffName}
        staffRole={staffRole}
        setStaffRole={setStaffRole}
        handleCreateStaff={(e) => {
          void handleCreateStaff(e);
        }}
        handleDeleteStaff={(id) => {
          void handleDeleteStaff(id);
        }}
        resources={resources as any}
        resName={resName}
        setResName={setResName}
        resType={resType}
        setResType={setResType}
        handleCreateResource={(e) => {
          void handleCreateResource(e);
        }}
        handleDeleteResource={(id) => {
          void handleDeleteResource(id);
        }}
        handleEntityImageChange={(kind, id, file) => {
          void handleEntityImageChange(kind, id, file);
        }}
        handleEntityImageDelete={(kind, id) => {
          void handleEntityImageDelete(kind, id);
        }}
      />
    );
  }

  return (
    <>
      <ConfirmActionModal
        open={confirmRevertBrandingOpen}
        title="Rollback branding draft"
        message="Revert draft branding to the last published version? This will overwrite your current draft."
        confirmLabel="Revert"
        cancelLabel="Cancel"
        danger={false}
        isBusy={confirmRevertBusy}
        onCancel={() => { if (!confirmRevertBusy) setConfirmRevertBrandingOpen(false); }}
        onConfirm={performRevertDraftToPublished}
      />
    <div style={{ minHeight: "100vh", backgroundImage: adminColors.pageBg, backgroundAttachment: "fixed" }}>
      <div style={{ padding: adminSpace.pagePad, maxWidth: 1200, margin: "0 auto", color: adminColors.text, fontFamily: "system-ui" }}>

        {/* Fixed hamburger (top-right) - hide while drawer is open so it doesn't cover the close X */}
        {!navOpen && (
          <button
            type="button"
            aria-label="Open menu"
            onClick={() => setNavOpen(true)}
            style={{
              position: "fixed",
              top: 18,
              right: 18,
              zIndex: adminZ.tooltip,
              width: 42,
              height: 42,
              borderRadius: 14,
              border: `1px solid ${adminColors.border}`,
              background: adminColors.surfaceStrong,
              boxShadow: adminColors.shadowSoft,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
            }}
          >
            <span aria-hidden="true" style={{ display: "grid", gap: 4 }}>
              <span style={{ width: 18, height: 2, background: "rgba(15,23,42,0.9)", borderRadius: 999 }} />
              <span style={{ width: 18, height: 2, background: "rgba(15,23,42,0.9)", borderRadius: 999 }} />
              <span style={{ width: 18, height: 2, background: "rgba(15,23,42,0.9)", borderRadius: 999 }} />
            </span>
          </button>
        )}

        {/* Drawer overlay */}
        {navOpen && (
          <div
            role="button"
            tabIndex={0}
            onClick={() => setNavOpen(false)}
            onKeyDown={(e) => e.key === "Escape" && setNavOpen(false)}
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.25)",
              zIndex: adminZ.modal,
            }}
          />
        )}

        {/* Right drawer */}
        <aside
          aria-hidden={!navOpen}
          style={{
            position: "fixed",
            top: 0,
            right: 0,
            bottom: 0,
            width: 300,
            transform: navOpen ? "translateX(0)" : "translateX(110%)",
            transition: "transform 200ms ease",
            zIndex: adminZ.tooltip,
            borderLeft: `1px solid ${adminColors.border}`,
            background: adminColors.surfaceStrong,
            boxShadow: adminColors.shadowSoft,
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <div style={{ fontWeight: 950, letterSpacing: 0.2 }}>{tenant.name}</div>
            <button
              type="button"
              aria-label="Close menu"
              onClick={() => setNavOpen(false)}
              style={{
                border: `1px solid ${adminColors.border}`,
                background: "#fff",
                color: adminColors.text,
                borderRadius: 12,
                padding: "8px 10px",
                cursor: "pointer",
                fontWeight: 900,
              }}
            >
              ✕
            </button>
          </div>

          <nav style={{ display: "grid", gap: 8 }}>
            {/* Dashboard (local tab) */}
            <button
              type="button"
              onClick={() => {
                setActiveTab("dashboard");
                setNavOpen(false);
              }}
              style={{
                width: "100%",
                textAlign: "left",
                padding: "10px 12px",
                borderRadius: 14,
                border: `1px solid ${adminColors.border}`,
                background:
                  activeTab === "dashboard"
                    ? `var(--bf-nav-active-bg, ${adminColors.surface2})`
                    : adminColors.surfaceStrong,
                color:
                  activeTab === "dashboard"
                    ? `var(--bf-nav-active-text, ${adminColors.text})`
                    : `var(--bf-nav-item-text, ${adminColors.text})`,
                cursor: "pointer",
                fontWeight: activeTab === "dashboard" ? 900 : 850,
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <Icon name="dashboard" />
              Dashboard
            </button>

            {[
              { id: "bookings", icon: "bookings", label: "Bookings" },
              { id: "add", icon: "add", label: "Add Booking" },
              { id: "dayview", icon: "day", label: "Day View" },
              { id: "customers", icon: "customers", label: "Customers" },
            ].map((item) => {
              const isActive = activeTab === (item.id as any);
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setActiveTab(item.id as any);
                    setNavOpen(false);
                  }}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    padding: "10px 12px",
                    borderRadius: 14,
                    border: `1px solid ${adminColors.border}`,
                    background: isActive ? `var(--bf-nav-active-bg, ${adminColors.surface2})` : adminColors.surfaceStrong,
                    color: isActive ? `var(--bf-nav-active-text, ${adminColors.text})` : `var(--bf-nav-item-text, ${adminColors.text})`,
                    cursor: "pointer",
                    fontWeight: isActive ? 900 : 850,
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                  }}
                >
                  <Icon name={item.icon as any} />
                  {item.label}
                </button>
              );
            })}

            <button
              type="button"
              onClick={() => {
                setActiveTab("staffSchedule");
                setNavOpen(false);
              }}
              style={{
                width: "100%",
                textAlign: "left",
                padding: "10px 12px",
                borderRadius: 14,
                border: `1px solid ${adminColors.border}`,
                background:
                  activeTab === "staffSchedule"
                    ? `var(--bf-nav-active-bg, ${adminColors.surface2})`
                    : adminColors.surfaceStrong,
                color:
                  activeTab === "staffSchedule"
                    ? `var(--bf-nav-active-text, ${adminColors.text})`
                    : `var(--bf-nav-item-text, ${adminColors.text})`,
                cursor: "pointer",
                fontWeight: activeTab === "staffSchedule" ? 900 : 850,
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <span
                style={{
                  width: 18,
                  height: 18,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                📅
              </span>
              Team Schedule
            </button>


            <button
              type="button"
              onClick={() => {
                setActiveTab("appearance");
                setNavOpen(false);
              }}
              style={{
                width: "100%",
                textAlign: "left",
                padding: "10px 12px",
                borderRadius: 14,
                border: `1px solid ${adminColors.border}`,
                background: activeTab === "appearance" ? `var(--bf-nav-active-bg, ${adminColors.surface2})` : adminColors.surfaceStrong,
                color: activeTab === "appearance" ? `var(--bf-nav-active-text, ${adminColors.text})` : `var(--bf-nav-item-text, ${adminColors.text})`,
                cursor: "pointer",
                fontWeight: activeTab === "appearance" ? 900 : 850,
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <span style={{ width: 18, height: 18, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>🎨</span>
              Theme Studio
            </button>

            <button
              type="button"
              onClick={() => {
                setNavOpen(false);
                const target = initialSetupPill || "hours";
                router.push(`/owner/${encodeURIComponent(slug)}/setup/${encodeURIComponent(target)}`);
              }}
              style={{
                width: "100%",
                textAlign: "left",
                padding: "10px 12px",
                borderRadius: 14,
                border: `1px solid ${adminColors.border}`,
                background: adminColors.surfaceStrong,
                color: `var(--bf-nav-item-text, ${adminColors.text})`,
                cursor: "pointer",
                fontWeight: 850,
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <Icon name="setup" />
              Settings
            </button>
          </nav>
          {/* Owner admin dashboard (platform) — keep at the bottom of the drawer */}
          <div style={{ marginTop: "auto" }}>
            <Link
              href="/owner/dashboard"
              onClick={() => setNavOpen(false)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                width: "100%",
                textDecoration: "none",
                padding: "10px 12px",
                borderRadius: 14,
                border: `1px solid ${adminColors.border}`,
                background: adminColors.surfaceStrong,
                color: `var(--bf-nav-item-text, ${adminColors.text})`,
                fontWeight: 850,
              }}
            >
              <Icon name="dashboard" />
              Owner Dashboard
            </Link>
          </div>
        </aside>

        {/* Time context bar (shared mental model across owner pages) */}

        {/* Dashboard-only header (TimeContext + KPIs) */}
        {activeTab === "dashboard" && (
          <>
            <div style={{ marginTop: 0 }}>
              <TimeContextBar
                mode={timeMode}
                onModeChange={setTimeMode}
                date={dayViewDate}
                onDateChange={setDayViewDate}
              />
            </div>

            <div
              style={{
                marginTop: adminSpace.gap,
                display: "flex",
                flexWrap: "nowrap",
                gap: 10,
                overflowX: "auto",
                paddingBottom: 6,
                WebkitOverflowScrolling: "touch",
              }}
            >
              <KpiCard
                size="sm"
                className="bf-kpi-item"
                label="Bookings Today"
                value={kpiCountsLoading ? "…" : kpiCounts.today}
                sublabel={dayViewDate}
                tone="neutral"
              />
              <KpiCard
                size="sm"
                className="bf-kpi-item"
                label="Upcoming Bookings"
                value={kpiCountsLoading ? "…" : kpiCounts.upcoming}
                sublabel={`Loaded: ${bookings.length}`}
                tone="good"
              />
              <KpiCard
                className="bf-kpi-item"
                size="sm"
                label="Customers"
                value={customers.length}
                sublabel="Profiles"
                tone="neutral"
              />
              <KpiCard
                className="bf-kpi-item"
                size="sm"
                label="Catalog"
                value={services.length + staff.length + resources.length}
                sublabel="Services + Staff + Resources"
                tone="neutral"
              />
            </div>
          </>
        )}


        {/* BOOKINGS TAB */}
        {activeTab === "bookings" && (
          <section style={{ marginTop: 16, border: `1px solid ${adminColors.border}`, borderRadius: adminRadii.card, background: adminColors.surfaceStrong, padding: 14, boxShadow: adminColors.shadowSoft }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 12, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 900 }}>Bookings</div>
                <div style={{ fontSize: 12, color: adminColors.muted }}>
                  Default is upcoming. Use filters to narrow results. Loads {PAGE_SIZE} at a time.
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <select
                  value={view}
                  onChange={(e) => setView(e.target.value as any)}
                  style={{ padding: "8px 10px", borderRadius: 12, border: `1px solid ${adminColors.border}`, background: "#fff", fontSize: 13 }}
                >
                  <option value="upcoming">Upcoming</option>
                  <option value="latest">Latest</option>
                  <option value="past">Past</option>
                  <option value="all">All</option>
                </select>

                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                  style={{ padding: "8px 10px", borderRadius: 12, border: `1px solid ${adminColors.border}`, background: "#fff", fontSize: 13 }}
                >
                  <option value="all">All statuses</option>
                  <option value="pending">Pending</option>
                  <option value="confirmed">Confirmed</option>
                  <option value="cancelled">Cancelled</option>
                </select>

                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search name / email / phone…"
                  style={{ padding: "8px 10px", borderRadius: 12, border: `1px solid ${adminColors.border}`, background: "#fff", fontSize: 13, minWidth: 240 }}
                />

                <button
                  onClick={() => fetchBookings(null, "replace")}
                  style={{
                    padding: "8px 12px",
                    borderRadius: 12,
                    border: "none",
                    background: "rgba(15,23,42,0.94)",
                    color: "#fff",
                    fontWeight: 850,
                    cursor: "pointer",
                  }}
                >
                  Apply
                </button>
              </div>
            </div>

            {bookingsError && (
              <div style={{ marginTop: 10, color: "#b91c1c", fontSize: 13 }}>
                ⚠ {bookingsError}
              </div>
            )}

            {bookingsLoading && (
              <div style={{ marginTop: 10, color: adminColors.muted, fontSize: 13 }}>
                Loading bookings…
              </div>
            )}

            <div style={{ marginTop: 12, overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: "left", borderBottom: `1px solid ${adminColors.border}` }}>
                    <th style={{ padding: "10px 8px" }}>Start</th>
                    <th style={{ padding: "10px 8px" }}>Customer</th>
                    <th style={{ padding: "10px 8px", minWidth: 160 }}>Service</th>
                    <th style={{ padding: "10px 8px" }}>Staff</th>
                    <th style={{ padding: "10px 8px", minWidth: 160 }}>Resource</th>
                    <th style={{ padding: "10px 8px" }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {bookings.map((b) => {
                    const svc = services.find((s) => s.id === b.service_id);
                    const st = staff.find((s) => s.id === b.staff_id);
                    const rs = resources.find((r) => r.id === b.resource_id);

                    const hovered = hoverBookingId === b.id;

	                    return (
                      <tr
                        key={b.id}
                        onMouseEnter={() => setHoverBookingId(b.id)}
                        onMouseLeave={() => setHoverBookingId(null)}
                        style={{
                          borderBottom: `1px solid ${adminColors.border}`,
                          background: hovered ? "rgba(79,70,229,0.05)" : "transparent",
                          cursor: "pointer",
                        }}
                        onClick={() => setSelectedBooking(b)}
                      >
                        <td style={{ padding: "10px 8px", whiteSpace: "nowrap" }}>
                          {b.start_time ? formatLocalDateTimeNoSeconds(b.start_time) : "—"}
                        </td>
                        <td style={{ padding: "10px 8px" }}>
                          <div style={{ fontWeight: 850 }}>{b.customer_name}</div>
                          <div style={{ color: adminColors.muted, fontSize: 12 }}>
                            {b.customer_email || b.customer_phone || "—"}
                          </div>
                        </td>
                        <td style={{ padding: "10px 8px", minWidth: 160 }}>{svc?.name || "—"}</td>
                        <td style={{ padding: "10px 8px" }}>{st?.name || "—"}</td>
                        <td style={{ padding: "10px 8px", minWidth: 160 }}>{rs?.name || "—"}</td>
                        <td style={{ padding: "10px 8px" }}>{b.status}</td>
                      </tr>
                    );
                  })}

                  {!bookings.length && !bookingsLoading && (
                    <tr>
                      <td colSpan={6} style={{ padding: 12, color: adminColors.muted }}>
                        No bookings found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div style={{ marginTop: 12, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <div style={{ color: adminColors.muted, fontSize: 12 }}>
                Showing <b style={{ color: adminColors.text }}>{bookings.length}</b> rows
              </div>

              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <button
                  disabled={!bookingsNextCursor || bookingsLoading}
                  onClick={() => {
                    if (!bookingsNextCursor) return;
                    fetchBookings(bookingsNextCursor, "append");
                  }}
                  style={{
                    padding: "8px 12px",
                    borderRadius: 12,
                    border: "none",
                    background: bookingsNextCursor ? "rgba(15,23,42,0.94)" : "rgba(15,23,42,0.25)",
                    color: "#fff",
                    fontWeight: 850,
                    cursor: bookingsNextCursor ? "pointer" : "not-allowed",
                  }}
                >
                  Load more
                </button>
              </div>
            </div>
          </section>
        )}

        {/* ADD TAB */}
        {activeTab === "add" && (
          <section style={{ marginTop: 16, border: `1px solid ${adminColors.border}`, borderRadius: adminRadii.card, background: adminColors.surfaceStrong, padding: 14, boxShadow: adminColors.shadowSoft }}>
            <div style={{ fontSize: 16, fontWeight: 900 }}>Add booking</div>
            <div style={{ fontSize: 12, color: adminColors.muted, marginTop: 2 }}>
              Create a booking manually. This uses the same backend API as the public booking flow.
            </div>

            {addError && (
              <div style={{ marginTop: 10, color: "#b91c1c", fontSize: 13 }}>
                ⚠ {addError}
              </div>
            )}

            <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
              <div>
                <div style={{ fontSize: 12, color: adminColors.muted, fontWeight: 800, marginBottom: 6 }}>Customer name</div>
                <div style={{ position: "relative" }}>
                  <input
                    value={addCustomerName}
                    onChange={(e) => {
                      setAddCustomerName(e.target.value);
                      setAddCustomerId("");
                      setAddCustomerSuggestOpen(true);
                    }}
                    onFocus={() => setAddCustomerSuggestOpen(true)}
                    onBlur={() => {
                      // Delay close so a click on a suggestion can register.
                      window.setTimeout(() => setAddCustomerSuggestOpen(false), 120);
                    }}
                    placeholder="Type at least 2 characters…"
                    style={{ width: "100%", padding: "10px 10px", borderRadius: 12, border: `1px solid ${adminColors.border}`, background: "#fff" }}
                  />

                  {addCustomerSuggestOpen && addCustomerMatches.length > 0 && (
                    <div
                      style={{
                        position: "absolute",
                        zIndex: 50,
                        top: "calc(100% + 6px)",
                        left: 0,
                        right: 0,
                        border: `1px solid ${adminColors.border}`,
                        borderRadius: 14,
                        background: "#fff",
                        boxShadow: "0 16px 32px rgba(15,23,42,0.12)",
                        overflow: "hidden",
                      }}
                    >
                      {addCustomerMatches.map((c) => (
                        <div
                          key={c.id}
                          onMouseDown={(e) => {
                            // onMouseDown prevents input blur before we set state.
                            e.preventDefault();
                            setAddCustomerId(c.id);
                            setAddCustomerName(c.name || "");
                            setAddCustomerPhone(c.phone || "");
                            setAddCustomerEmail(c.email || "");
                            setAddCustomerSuggestOpen(false);
                          }}
                          style={{
                            padding: "10px 12px",
                            cursor: "pointer",
                            borderBottom: `1px solid ${adminColors.border}`,
                          }}
                        >
                          <div style={{ fontWeight: 900 }}>{c.name}</div>
                          <div style={{ fontSize: 12, color: adminColors.muted, marginTop: 2 }}>
                            {(c.phone || "—") + " • " + (c.email || "—")}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div>
                <div style={{ fontSize: 12, color: adminColors.muted, fontWeight: 800, marginBottom: 6 }}>Phone</div>
                <input
                  value={addCustomerPhone}
                  onChange={(e) => setAddCustomerPhone(e.target.value)}
                  style={{ width: "100%", padding: "10px 10px", borderRadius: 12, border: `1px solid ${adminColors.border}`, background: "#fff" }}
                />
              </div>

              <div>
                <div style={{ fontSize: 12, color: adminColors.muted, fontWeight: 800, marginBottom: 6 }}>Email</div>
                <input
                  value={addCustomerEmail}
                  onChange={(e) => setAddCustomerEmail(e.target.value)}
                  style={{ width: "100%", padding: "10px 10px", borderRadius: 12, border: `1px solid ${adminColors.border}`, background: "#fff" }}
                />

              <div>
                <div style={{ fontSize: 12, color: adminColors.muted, fontWeight: 800, marginBottom: 6 }}>Membership credits</div>
                <label style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 10px", borderRadius: 12, border: `1px solid ${adminColors.border}`, background: "#fff", cursor: addCustomerId ? "pointer" : "not-allowed", opacity: addCustomerId ? 1 : 0.65 }}>
                  <input
                    type="checkbox"
                    checked={addUseMembershipCredits}
                    disabled={!addCustomerId}
                    onChange={(e) => setAddUseMembershipCredits(e.target.checked)}
                  />
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    <div style={{ fontWeight: 850 }}>Use membership credits</div>
                    <div style={{ fontSize: 12, color: adminColors.muted }}>
                      Requires selecting an existing customer (so we can debit their membership + write a ledger line).
                    </div>
                  </div>
                </label>
              </div>

              </div>

              <div>
                <div style={{ fontSize: 12, color: adminColors.muted, fontWeight: 800, marginBottom: 6 }}>Service</div>
                <select
                  value={addServiceId}
                  onChange={(e) => setAddServiceId(e.target.value ? Number(e.target.value) : "")}
                  style={{ width: "100%", padding: "10px 10px", borderRadius: 12, border: `1px solid ${adminColors.border}`, background: "#fff" }}
                >
                  <option value="">Select…</option>
                  {services.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} • {s.duration_minutes}m • {formatMoney(Number(s.price_amount || 0), currency)}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div style={{ fontSize: 12, color: adminColors.muted, fontWeight: 800, marginBottom: 6 }}>Staff (optional)</div>
                <select
                  value={addStaffId}
                  onChange={(e) => setAddStaffId(e.target.value ? Number(e.target.value) : "")}
                  style={{ width: "100%", padding: "10px 10px", borderRadius: 12, border: `1px solid ${adminColors.border}`, background: "#fff" }}
                >
                  <option value="">None</option>
                  {staff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div style={{ fontSize: 12, color: adminColors.muted, fontWeight: 800, marginBottom: 6 }}>Resource (optional)</div>
                <select
                  value={addResourceId}
                  onChange={(e) => setAddResourceId(e.target.value ? Number(e.target.value) : "")}
                  style={{ width: "100%", padding: "10px 10px", borderRadius: 12, border: `1px solid ${adminColors.border}`, background: "#fff" }}
                >
                  <option value="">None</option>
                  {resources.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div style={{ fontSize: 12, color: adminColors.muted, fontWeight: 800, marginBottom: 6 }}>Start time (local)</div>
                <input
                  value={addStartTime}
                  onChange={(e) => setAddStartTime(e.target.value)}
                  type="datetime-local"
                  style={{ width: "100%", padding: "10px 10px", borderRadius: 12, border: `1px solid ${adminColors.border}`, background: "#fff" }}
                />
              </div>

              <div>
                <div style={{ fontSize: 12, color: adminColors.muted, fontWeight: 800, marginBottom: 6 }}>Duration (minutes)</div>
                <input
                  value={String(addDuration)}
                  onChange={(e) => setAddDuration(Number(e.target.value || 60))}
                  type="number"
                  min={5}
                  step={5}
                  style={{ width: "100%", padding: "10px 10px", borderRadius: 12, border: `1px solid ${adminColors.border}`, background: "#fff" }}
                />
              </div>

              <div>
                <div style={{ fontSize: 12, color: adminColors.muted, fontWeight: 800, marginBottom: 6 }}>Status</div>
                <select
                  value={addStatus}
                  onChange={(e) => setAddStatus(e.target.value)}
                  style={{ width: "100%", padding: "10px 10px", borderRadius: 12, border: `1px solid ${adminColors.border}`, background: "#fff" }}
                >
                  {allowPending ? <option value="pending">pending</option> : null}
                  <option value="confirmed">confirmed</option>
                  <option value="cancelled">cancelled</option>
                </select>
              </div>
            </div>

            <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
              <button
                onClick={createBooking}
                disabled={addSaving}
                style={{
                  padding: "10px 14px",
                  borderRadius: 12,
                  border: "none",
                  background: addSaving ? "rgba(15,23,42,0.35)" : "rgba(15,23,42,0.94)",
                  color: "#fff",
                  fontWeight: 900,
                  cursor: addSaving ? "not-allowed" : "pointer",
                }}
              >
                {addSaving ? "Saving…" : "Create booking"}
              </button>
            </div>
          </section>
        )}

        {/* SETUP TAB */}
        
        {activeTab === "appearance" && (
          <div
            style={{
              border: `1px solid ${adminColors.border}`,
              background: adminColors.surfaceStrong,
              boxShadow: adminColors.shadowSoft,
              borderRadius: adminRadii.card,
              padding: 16,
              marginTop: 14,
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 950, letterSpacing: -0.2 }}>Theme Studio</div>
                <div style={{ color: adminColors.muted, marginTop: 4, maxWidth: 760 }}>
                  Theme dictates layout. Changes here apply to the public booking page immediately after publish.
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {/* Draft vs Live (publish protocol) */}
                <div
                  style={{
                    padding: "6px 10px",
                    borderRadius: 999,
                    border: `1px solid ${adminColors.border}`,
                    background: adminColors.surface2,
                    fontWeight: 900,
                    fontSize: 12,
                  }}
                  title={
                    publishLoading
                      ? "Loading publish status…"
                      : (() => {
                          const status = String(publishMeta?.computed?.publish_status || publishMeta?.persisted?.publish_status || "draft");
                          const publishedAt = publishMeta?.persisted?.published_at ? formatLocalDateTimeNoSeconds(publishMeta.persisted.published_at) : null;
                          const base = `Status: ${status}`;
                          return publishedAt ? `${base}\nPublished: ${publishedAt}` : base;
                        })()
                  }
                >
                  {(() => {
                    const persisted = String(publishMeta?.persisted?.publish_status || "draft");
                    const isLive = persisted === "published" && !hasUnpublishedBrandingChanges;
                    return isLive ? "Live" : "Draft";
                  })()}
                  {hasUnpublishedBrandingChanges ? " • Unpublished" : ""}
                </div>

                <div
                  style={{
                    padding: "6px 10px",
                    borderRadius: 999,
                    border: `1px solid ${adminColors.border}`,
                    background: adminColors.surface2,
                    fontWeight: 900,
                    fontSize: 12,
                  }}
                  title="This is the currently published theme key"
                >
                  Live Theme: {selectedThemeKey || tenant?.theme_key || "classic"}
                </div>

                <Link
                  href={`/book/${slug}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    textDecoration: "none",
                    padding: "8px 12px",
                    borderRadius: 12,
                    border: `1px solid ${adminColors.border}`,
                    background: "#fff",
                    color: adminColors.text,
                    fontWeight: 900,
                  }}
                >
                  Preview booking page
                </Link>
              </div>
            </div>

            {!!appearanceMessage && (
              <div style={{ marginTop: 10, fontWeight: 800, color: appearanceMessage.includes("failed") ? "#b91c1c" : adminColors.text }}>
                {appearanceMessage}
              </div>
            )}

            {/* Publish protocol banner + guardrails */}
            <div
              style={{
                marginTop: 12,
                borderRadius: 16,
                border: `1px solid ${adminColors.border}`,
                background: hasUnpublishedBrandingChanges ? "rgba(245, 158, 11, 0.10)" : adminColors.surface2,
                padding: 14,
              }}
            >
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div style={{ display: "grid", gap: 4 }}>
                  <div style={{ fontWeight: 950 }}>
                    {hasUnpublishedBrandingChanges ? "You have unpublished changes" : "Booking page publish status"}
                  </div>
                  <div style={{ color: adminColors.muted, fontSize: 13, maxWidth: 860 }}>
                    Publishing updates the <b>live booking page</b> snapshot (safe, last-known-good). Saving edits only updates your draft.
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    disabled={
                      publishActionLoading ||
                      publishLoading ||
                      !(publishMeta?.computed?.ok ?? true) ||
                      !hasUnpublishedBrandingChanges
                    }
                    onClick={publishTenantSnapshot}
                    style={{
                      borderRadius: 12,
                      padding: "10px 14px",
                      border: `1px solid ${adminColors.border}`,
                      background: "var(--bf-brand-primary, #2563eb)",
                      color: "#fff",
                      fontWeight: 950,
                      cursor: "pointer",
                      opacity:
                        publishActionLoading || publishLoading || !(publishMeta?.computed?.ok ?? true) || !hasUnpublishedBrandingChanges
                          ? 0.55
                          : 1,
                    }}
                  >
                    {publishActionLoading ? "Publishing…" : "Publish booking page"}
                  </button>

                  <button
                    type="button"
                    disabled={publishActionLoading || publishLoading || !hasPublishedSnapshot || !hasUnpublishedBrandingChanges}
                    onClick={revertDraftToPublished}
                    style={{
                      borderRadius: 12,
                      padding: "10px 14px",
                      border: `1px solid ${adminColors.border}`,
                      background: "#fff",
                      color: adminColors.text,
                      fontWeight: 950,
                      cursor: "pointer",
                      opacity:
                        publishActionLoading || publishLoading || !hasPublishedSnapshot || !hasUnpublishedBrandingChanges ? 0.55 : 1,
                    }}
                  >
                    Revert to last published
                  </button>
                </div>
              </div>

              {/* Block reasons */}
              {publishMeta && publishMeta?.computed && publishMeta?.computed?.ok === false && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontWeight: 950, color: "#b45309" }}>Publish is disabled (blocked)</div>
                  <div style={{ color: adminColors.muted, fontSize: 13, marginTop: 4 }}>
                    Fix these items in Setup, then come back to publish.
                  </div>
                  <ul style={{ margin: "10px 0 0", paddingLeft: 18, display: "grid", gap: 6 }}>
                    {(publishMeta?.computed?.errors || []).slice(0, 8).map((e: any, idx: number) => (
                      <li key={idx} style={{ fontSize: 13, fontWeight: 800, color: adminColors.text }}>
                        {e?.message || String(e)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Warnings (non-blocking) */}
              {publishMeta && Array.isArray(publishMeta?.computed?.warnings) && publishMeta.computed.warnings.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontWeight: 950, color: adminColors.text }}>Warnings (won’t block publish)</div>
                  <ul style={{ margin: "8px 0 0", paddingLeft: 18, display: "grid", gap: 6 }}>
                    {publishMeta.computed.warnings.slice(0, 6).map((w: any, idx: number) => (
                      <li key={idx} style={{ fontSize: 13, color: adminColors.muted, fontWeight: 800 }}>
                        {w?.message || String(w)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {/* Theme picker */}
            <div style={{ marginTop: 16 }}>
              <div style={{ fontWeight: 950, marginBottom: 8 }}>Theme (layout)</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                {[
                  { key: "classic", title: "Classic", desc: "Clean, simple layout" },
                  { key: "premium", title: "Premium", desc: "Glass hero + SaaS-grade UI" },
                  { key: "premium_light", title: "Premium Light", desc: "Premium layout, inverted (white + dark text)" },
                ].map((t) => {
                  const isActive = (selectedThemeKey || tenant?.theme_key || "classic") === t.key;
                  return (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => setSelectedThemeKey(t.key)}
                      style={{
                        textAlign: "left",
                        width: "100%",
                        borderRadius: 16,
                        border: `1px solid ${adminColors.border}`,
                        background: isActive ? adminColors.surface2 : "#fff",
                        padding: 14,
                        cursor: "pointer",
                        boxShadow: isActive ? "0 14px 30px rgba(15,23,42,0.10)" : "none",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                        <div style={{ fontWeight: 950 }}>{t.title}</div>
                        <div style={{ fontSize: 12, fontWeight: 900, opacity: isActive ? 1 : 0.6 }}>
                          {isActive ? "Selected" : "Select"}
                        </div>
                      </div>
                      <div style={{ color: adminColors.muted, marginTop: 6, fontSize: 13 }}>{t.desc}</div>
                    </button>
                  );
                })}
              </div>

              <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button
                  type="button"
                  disabled={appearanceSaving || !selectedThemeKey}
                  onClick={() => saveTenantThemeKey(selectedThemeKey || "classic")}
                  style={{
                    borderRadius: 12,
                    padding: "10px 14px",
                    border: `1px solid ${adminColors.border}`,
                    background: "var(--bf-brand-primary, #2563eb)",
                    color: "#fff",
                    fontWeight: 950,
                    cursor: appearanceSaving ? "not-allowed" : "pointer",
                    opacity: appearanceSaving ? 0.7 : 1,
                  }}
                >
                  Publish theme
                </button>
              </div>
            </div>

            {/* Colors + controls */}
            <div style={{ marginTop: 18, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14 }}>
              <div style={{ border: `1px solid ${adminColors.border}`, borderRadius: 16, padding: 14, background: "#fff" }}>
                <div style={{ fontWeight: 950, marginBottom: 10 }}>Brand Setup (stable)</div>

                <div style={{ display: "grid", gap: 10 }}>
                  <label style={{ display: "grid", gap: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 900, color: adminColors.muted }}>Button radius</span>
                    <input
                      type="range"
                      min={0}
                      max={28}
                      value={Number(brandingDraft?.buttons?.radius ?? 14)}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setBrandingDraft((prev: any) => ({
                          ...(prev || {}),
                          buttons: { ...((prev || {})?.buttons || {}), radius: v },
                        }));
                      }}
                    />
                    <span style={{ fontSize: 12, fontWeight: 900 }}>{Number(brandingDraft?.buttons?.radius ?? 14)}px</span>
                  </label>

                  <label style={{ display: "grid", gap: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 900, color: adminColors.muted }}>Hero mode</span>
                    <select
                      value={String(brandingDraft?.bookingUi?.heroMode ?? "tab-banners")}
                      onChange={(e) =>
                        setBrandingDraft((prev: any) => ({
                          ...(prev || {}),
                          bookingUi: { ...((prev || {})?.bookingUi || {}), heroMode: e.target.value },
                        }))
                      }
                      style={{
                        border: `1px solid ${adminColors.border}`,
                        borderRadius: 12,
                        padding: "10px 12px",
                        fontWeight: 800,
                        background: "#fff",
                      }}
                    >
                      <option value="tab-banners">Tab banners</option>
                      <option value="hero-only">Hero only</option>
                      <option value="none">None</option>
                    </select>
                  </label>

                  <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 12px", borderRadius: 12, border: `1px solid ${adminColors.border}`, background: adminColors.surface2 }}>
                    <div style={{ display: "grid", gap: 2 }}>
                      <span style={{ fontSize: 12, fontWeight: 900, color: adminColors.muted }}>Require phone for booking</span>
                      <span style={{ fontSize: 12, color: adminColors.muted }}>
                        If enabled, customers must add their phone number once during onboarding.
                      </span>
                    </div>
                    <input
                      type="checkbox"
                      checked={Boolean(brandingDraft?.require_phone ?? true)}
                      onChange={(e) =>
                        setBrandingDraft((prev: any) => ({ ...(prev || {}), require_phone: e.target.checked }))
                      }
                      style={{ width: 18, height: 18 }}
                    />
                  </label>

                  {/* Home offers (public booking page) */}
                  <div
                    style={{
                      display: "grid",
                      gap: 6,
                      padding: "10px 12px",
                      borderRadius: 12,
                      border: `1px solid ${adminColors.border}`,
                      background: adminColors.surface2,
                    }}
                  >
                    <div style={{ display: "grid", gap: 2 }}>
                      <span style={{ fontSize: 12, fontWeight: 900, color: adminColors.muted }}>Home offers</span>
                      <span style={{ fontSize: 12, color: adminColors.muted }}>
                        These lines appear on the customer Home tab (light dashboard). One offer per line.
                      </span>
                    </div>
                    <textarea
                      value={
                        Array.isArray((brandingDraft as any)?.offers)
                          ? String(((brandingDraft as any)?.offers || []).join("\n"))
                          : typeof (brandingDraft as any)?.offers === "string"
                            ? String((brandingDraft as any)?.offers)
                            : ""
                      }
                      onChange={(e) => {
                        const lines = e.target.value
                          .split(/\r?\n/g)
                          .map((x) => x.trim())
                          .filter(Boolean)
                          .slice(0, 8);
                        setBrandingDraft((prev: any) => ({ ...(prev || {}), offers: lines }));
                      }}
                      rows={5}
                      placeholder="e.g.\n• 10% off weekday mornings\n• Free drink with 2 hours booking"
                      style={{
                        width: "100%",
                        borderRadius: 12,
                        border: `1px solid ${adminColors.border}`,
                        padding: 10,
                        fontSize: 13,
                        background: "#fff",
                        color: adminColors.text,
                        resize: "vertical",
                      }}
                    />
                  </div>

                  <button
                    type="button"
                    disabled={appearanceSaving}
                    onClick={() => saveTenantBrandingPatch({ branding: brandingDraft })}
                    style={{
                      marginTop: 6,
                      borderRadius: 12,
                      padding: "10px 14px",
                      border: `1px solid ${adminColors.border}`,
                      background: "#fff",
                      color: adminColors.text,
                      fontWeight: 950,
                      cursor: appearanceSaving ? "not-allowed" : "pointer",
                      opacity: appearanceSaving ? 0.7 : 1,
                    }}
                  >
                    Save brand setup
                  </button>
                </div>
              </div>

              <div style={{ border: `1px solid ${adminColors.border}`, borderRadius: 16, padding: 14, background: "#fff" }}>
                <div style={{ fontWeight: 950, marginBottom: 10 }}>Theme Studio (tokens)</div>

                <div style={{ display: "grid", gap: 12 }}>
                  {[
                    { key: "--bf-brand-primary", label: "Primary" },
                    { key: "--bf-brand-primary-dark", label: "Primary (Dark)" },
                  ].map((item) => {
                    const raw = String((themeStudioDraft as any)?.[item.key] || "");
                    const safe = raw && raw.startsWith("#") ? raw : "#2563eb";
                    return (
                      <div key={item.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                        <div style={{ display: "grid", gap: 4 }}>
                          <div style={{ fontSize: 12, fontWeight: 900, color: adminColors.muted }}>{item.label}</div>
                          <div style={{ fontSize: 12, fontWeight: 900 }}>{item.key}</div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <input
                            type="color"
                            value={safe}
                            onChange={(e) =>
                              setThemeStudioDraft((prev) => ({ ...(prev || {}), [item.key]: e.target.value }))
                            }
                            style={{ width: 44, height: 36, border: `1px solid ${adminColors.border}`, borderRadius: 10, background: "#fff" }}
                          />
                          <input
                            type="text"
                            value={raw}
                            onChange={(e) =>
                              setThemeStudioDraft((prev) => ({ ...(prev || {}), [item.key]: e.target.value }))
                            }
                            placeholder="#2563eb"
                            style={{
                              width: 120,
                              border: `1px solid ${adminColors.border}`,
                              borderRadius: 12,
                              padding: "10px 12px",
                              fontWeight: 800,
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}

                  <button
                    type="button"
                    disabled={appearanceSaving}
                    onClick={() => saveTenantBrandingPatch({ brand_overrides: themeStudioDraft })}
                    style={{
                      marginTop: 4,
                      borderRadius: 12,
                      padding: "10px 14px",
                      border: `1px solid ${adminColors.border}`,
                      background: "#fff",
                      color: adminColors.text,
                      fontWeight: 950,
                      cursor: appearanceSaving ? "not-allowed" : "pointer",
                      opacity: appearanceSaving ? 0.7 : 1,
                    }}
                  >
                    Save Theme Studio
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

{activeTab === "setup" && (
          <OwnerSetupTab
            tenantName={tenant.name}
            apiBase={OWNER_API}
            uploadBase={"/api/owner/proxy-upload"}
            initialPill={initialSetupPill}
            tenant={tenant as any}
            themeStudioDraft={themeStudioDraft}
            setThemeStudioDraft={setThemeStudioDraft}
            onSaveBrandOverrides={() => {
              void saveTenantBrandingPatch({ brand_overrides: themeStudioDraft || {} });
            }}
            onTenantUpdated={(t) => setTenant(t as any)}
            setupMessage={setupMessage}
            logoError={logoError}
            logoUploading={logoUploading}
            handleLogoFileChange={(e) => {
              void handleLogoFileChange(e);
            }}
            workingHours={workingHours as any}
            handleWorkingHoursChange={handleWorkingHoursChange as any}
            savingWorkingHours={savingWorkingHours}
            handleSaveWorkingHours={() => {
              void handleSaveWorkingHours();
            }}
            services={services as any}
            svcName={svcName}
            setSvcName={setSvcName}
            svcDuration={svcDuration}
            setSvcDuration={setSvcDuration}
            svcPrice={svcPrice}
            setSvcPrice={setSvcPrice}
            svcReqStaff={svcReqStaff}
            setSvcReqStaff={setSvcReqStaff}
            svcReqRes={svcReqRes}
            setSvcReqRes={setSvcReqRes}
            svcRequiresConfirmation={svcRequiresConfirmation}
            setSvcRequiresConfirmation={setSvcRequiresConfirmation}
            svcInterval={svcInterval}
            setSvcInterval={setSvcInterval}
            svcMaxSlots={svcMaxSlots}
            setSvcMaxSlots={setSvcMaxSlots}
            svcParallel={svcParallel}
            setSvcParallel={setSvcParallel}
            handleCreateService={(e) => {
              void handleCreateService(e);
            }}
            handleDeleteService={(id) => {
              void handleDeleteService(id);
            }}
            handleUpdateServiceAvailabilityBasis={(id, basis) => {
              void handleUpdateServiceAvailabilityBasis(id, basis);
            }}
            handlePatchService={(id, patch) => {
              void handlePatchService(id, patch);
            }}
            staff={staff as any}
            staffName={staffName}
            setStaffName={setStaffName}
            staffRole={staffRole}
            setStaffRole={setStaffRole}
            handleCreateStaff={(e) => {
              void handleCreateStaff(e);
            }}
            handleDeleteStaff={(id) => {
              void handleDeleteStaff(id);
            }}
            resources={resources as any}
            resName={resName}
            setResName={setResName}
            resType={resType}
            setResType={setResType}
            handleCreateResource={(e) => {
              void handleCreateResource(e);
            }}
            handleDeleteResource={(id) => {
              void handleDeleteResource(id);
            }}
            handleEntityImageChange={(kind, id, file) => {
              void handleEntityImageChange(kind, id, file);
            }}
            handleEntityImageDelete={(kind, id) => {
              void handleEntityImageDelete(kind, id);
            }}
          />
        )}

        {/* DAY VIEW TAB */}
        {activeTab === "dayview" && (
          <div style={{ marginTop: 16 }}>
            {dayViewError && (
              <div style={{ marginBottom: 10, color: "#b91c1c", fontSize: 13 }}>⚠ {dayViewError}</div>
            )}

            {dayViewLoading && (
              <div style={{ marginBottom: 10, color: adminColors.muted, fontSize: 13 }}>Loading day view…</div>
            )}

            <OwnerDayViewTab
              dayViewDate={dayViewDate}
              setDayViewDate={setDayViewDate}
              refreshBookings={() => { void refreshDayViewBookings(dayViewDate); }}
              resources={resources}
              hours={dayViewHours}
              findBookingForSlot={findBookingForSlot}
            />
          </div>
        )}

        {/* CUSTOMERS TAB */}
        {activeTab === "customers" && (
          <div style={{ marginTop: 16 }}>
            <OwnerCustomersTab tenantSlug={slug} customers={customers as any} setCustomers={setCustomers as any} />
          </div>
        )}

        {/* STAFF SCHEDULE TAB */}
        {activeTab === "staffSchedule" && (
          <div style={{ marginTop: 16 }}>
            <TeamScheduleClient tenantSlug={slug} scope="admin" backHref={null} />
          </div>
        )}

        {/* Modal */}
        {selectedBooking && (
          <ModalOverlay onClose={() => setSelectedBooking(null)} closeOnBackdrop={false}>
            <div
              style={{
                background: "#fff",
                borderRadius: 18,
                border: `1px solid ${adminColors.border}`,
                boxShadow: "0 18px 60px rgba(15,23,42,0.18)",
                padding: 16,
                display: "grid",
                gap: 12,
                height: "100%",
              }}
            >
              {/* Header */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                  paddingBottom: 10,
                  borderBottom: `1px solid ${adminColors.border}`,
                }}
              >
                <div style={{ fontWeight: 950, fontSize: 16 }}>
                  Booking #{selectedBooking.id}
                </div>
        
                <button
                  onClick={() => setSelectedBooking(null)}
                  aria-label="Close"
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 12,
                    border: `1px solid ${adminColors.border}`,
                    background: "#fff",
                    cursor: "pointer",
                    fontWeight: 900,
                    lineHeight: "34px",
                  }}
                >
                  ✕
                </button>
              </div>
        
              {/* Body */}
              <div style={{ display: "grid", gap: 12 }}>
                {/* Key timing */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                    gap: 10,
                  }}
                >
                  <div>
                    <div style={{ fontSize: 12, color: adminColors.muted, fontWeight: 800 }}>Start</div>
                    <div style={{ fontWeight: 900 }}>
                      {selectedBooking.start_time ? formatLocalDateTimeNoSeconds(selectedBooking.start_time) : "—"}
                    </div>
                  </div>

                  <div>
                    <div style={{ fontSize: 12, color: adminColors.muted, fontWeight: 800 }}>End</div>
                    <div style={{ fontWeight: 900 }}>
                      {selectedBooking.ends_at
                        ? formatLocalDateTimeNoSeconds(selectedBooking.ends_at)
                        : selectedBooking.start_time && selectedBooking.duration_minutes
                        ? formatLocalDateTimeNoSeconds(addMinutesISO(selectedBooking.start_time, Number(selectedBooking.duration_minutes)))
                        : "—"}
                    </div>
                  </div>

                  <div>
                    <div style={{ fontSize: 12, color: adminColors.muted, fontWeight: 800 }}>Duration</div>
                    <div style={{ fontWeight: 900 }}>
                      {selectedBooking.duration_minutes ? `${selectedBooking.duration_minutes} minutes` : "—"}
                    </div>
                  </div>

                  <div>
                    <div style={{ fontSize: 12, color: adminColors.muted, fontWeight: 800 }}>Status</div>
                    <div style={{ fontWeight: 900, textTransform: "capitalize" }}>{selectedBooking.status || "—"}</div>
                  </div>
                </div>

                {/* Entities */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                    gap: 10,
                  }}
                >
                  <div>
                    <div style={{ fontSize: 12, color: adminColors.muted, fontWeight: 800 }}>Customer</div>
                    <div style={{ fontWeight: 900 }}>{selectedBooking.customer_name || "—"}</div>
                    <div style={{ fontSize: 12, color: adminColors.muted }}>
                      {selectedBooking.customer_email || selectedBooking.customer_phone || "—"}
                    </div>
                    {(selectedBooking as any)?.customer_id ? (
                      <div style={{ fontSize: 12, color: adminColors.muted, marginTop: 4 }}>
                        ID: {(selectedBooking as any).customer_id}
                      </div>
                    ) : null}
                  </div>

                  <div>
                    <div style={{ fontSize: 12, color: adminColors.muted, fontWeight: 800 }}>Service</div>
                    <div style={{ fontWeight: 900 }}>
                      {selectedBooking.service_name || services.find((s) => s.id === selectedBooking.service_id)?.name || "—"}
                    </div>
                    {selectedBooking.service_id ? (
                      <div style={{ fontSize: 12, color: adminColors.muted, marginTop: 4 }}>ID: {selectedBooking.service_id}</div>
                    ) : null}
                  </div>

                  <div>
                    <div style={{ fontSize: 12, color: adminColors.muted, fontWeight: 800 }}>Staff</div>
                    <div style={{ fontWeight: 900 }}>
                      {selectedBooking.staff_name || staff.find((s) => s.id === selectedBooking.staff_id)?.name || "—"}
                    </div>
                    {selectedBooking.staff_id ? (
                      <div style={{ fontSize: 12, color: adminColors.muted, marginTop: 4 }}>ID: {selectedBooking.staff_id}</div>
                    ) : null}
                  </div>

                  <div>
                    <div style={{ fontSize: 12, color: adminColors.muted, fontWeight: 800 }}>Resource</div>
                    <div style={{ fontWeight: 900 }}>
                      {selectedBooking.resource_name || resources.find((r) => r.id === selectedBooking.resource_id)?.name || "—"}
                    </div>
                    {selectedBooking.resource_id ? (
                      <div style={{ fontSize: 12, color: adminColors.muted, marginTop: 4 }}>ID: {selectedBooking.resource_id}</div>
                    ) : null}
                  </div>
                </div>

                {/* Money + audit */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                    gap: 10,
                  }}
                >
                  <div>
                    <div style={{ fontSize: 12, color: adminColors.muted, fontWeight: 800 }}>Total price</div>
                    <div style={{ fontWeight: 900 }}>
                      {typeof selectedBooking.total_price === "number" ? formatMoney(selectedBooking.total_price, currency) : "—"}
                    </div>
                  </div>

                  <div>
                    <div style={{ fontSize: 12, color: adminColors.muted, fontWeight: 800 }}>Created</div>
                    <div style={{ fontWeight: 900 }}>
                      {selectedBooking.created_at ? formatLocalDateTimeNoSeconds(selectedBooking.created_at) : "—"}
                    </div>
                  </div>

                  {(selectedBooking as any)?.notes ? (
                    <div style={{ gridColumn: "1 / -1" }}>
                      <div style={{ fontSize: 12, color: adminColors.muted, fontWeight: 800 }}>Notes</div>
                      <div style={{ fontWeight: 800, whiteSpace: "pre-wrap" }}>{String((selectedBooking as any).notes)}</div>
                    </div>
                  ) : null}
                </div>
        
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 6 }}>
                  {(() => {
                    const current = String(selectedBooking.status || "").toLowerCase();
                    const isCancelled = current === "cancelled";

                    const statuses = [
                      ...(allowPending ? (["pending"] as const) : []),
                      "confirmed" as const,
                      "cancelled" as const,
                    ];

                    return statuses
                      // Keep cancelled terminal
                      .filter((s) => (isCancelled ? s === "cancelled" : true))
                      .map((s) => {
                        const isActive = current === s;
                        return (
                          <button
                            key={s}
                            onClick={() => updateBookingStatus(selectedBooking.id, s)}
                            disabled={isActive}
                            style={{
                              padding: "8px 12px",
                              borderRadius: 12,
                              border: `1px solid ${adminColors.border}`,
                              background: isActive ? "rgba(79,70,229,0.10)" : "#fff",
                              cursor: isActive ? "default" : "pointer",
                              fontWeight: 850,
                              opacity: isActive ? 0.75 : 1,
                            }}
                          >
                            Set {s}
                          </button>
                        );
                      });
                  })()}
        
                  <button
                    onClick={() => updateBookingStatus(selectedBooking.id, "cancelled")}
                    style={{
                      padding: "8px 12px",
                      borderRadius: 12,
                      border: "none",
                      background: "rgba(244,63,94,0.92)",
                      color: "#fff",
                      cursor: "pointer",
                      fontWeight: 900,
                      marginLeft: "auto",
                    }}
                  >
                    Cancel booking
                  </button>
                </div>
              </div>
            </div>
          </ModalOverlay>
        )}
      </div>
    </div>
    </>
  );
}
