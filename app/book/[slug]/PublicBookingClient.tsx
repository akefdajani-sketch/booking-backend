"use client";

import { ThemeProvider } from "@/lib/theme/ThemeContext";
import TenantCssVarsProvider from "@/lib/theme/TenantCssVarsProvider";
import { useEffect, useState, useMemo, FormEvent } from "react";

import { defaultTheme } from "@/lib/theme/defaultTheme";
import { resolveTheme } from "@/lib/theme/resolveTheme";
import type { Theme, ThemeOverride } from "@/lib/theme/types";
import { createCardStyle } from "@/lib/theme/styles";
import { getBookingLayout, normalizeLayoutName } from "@/components/booking/layouts/layoutRegistry";

type SsrThemeBootstrap = {
  themeKey: string;
  layoutKey: string;
  themeTokens: Record<string, string>;
  brandOverrides: Record<string, string>;
  branding?: any;
};


import { useParams, useRouter } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import Image from "next/image";
import { redirectToCentralGoogleAuth } from "@/lib/auth/redirectToCentralAuth";

// Premium layout styling (DB-driven via published theme.layout_key)
import premiumStyles from "@/app/book/design/premium/premium1.module.css";

import HeroBanner from "@/components/booking/HeroBanner";
import ModalOverlay from "@/components/booking/ModalOverlay";

import { useCustomerAuth } from "@/lib/booking/hooks/useCustomerAuth";
import type { Customer } from "@/lib/booking/hooks/useCustomerAuth";
import { useBookingHistory } from "@/lib/booking/hooks/useBookingHistory";
import { useAvailability } from "@/lib/booking/hooks/useAvailability";
import { useMemberships } from "@/lib/booking/hooks/useMemberships";
import { useTenantData } from "@/lib/booking/hooks/useTenantData";
import { useCreateBooking, type CreateBookingInput } from "@/lib/booking/hooks/useCreateBooking";

import type { BookingHistoryItem } from "@/types/booking";

import {
  formatLocalDate,
  formatHoursFromMinutes,
  isContiguousSelection,
  initialsFromName,
} from "@/lib/booking/utils";

import BottomNav, {
  type NavItem,
  type ActiveTab,
} from "@/components/booking/BottomNav";
import BookingHistory from "@/components/booking/BookingHistory";
import { useCustomerVersionsGate } from "@/lib/booking/hooks/useCustomerVersionsGate";
import ConfirmationModal from "@/components/booking/ConfirmationModal";
import BookingDetailsCard from "@/components/booking/BookingDetailsCard";
import HomeWelcomeCard from "@/components/booking/HomeWelcomeCard";
import BookingFormCard from "@/components/booking/BookingFormCard";
import AccountTab from "@/components/booking/AccountTab";
import MembershipsTab from "@/components/booking/MembershipsTab";
import { getStoredGoogleToken } from "@/lib/auth/centralToken";
import { buildLandingAboutSections } from "@/lib/booking/landingAbout";

const BACKEND_URL = "/api/proxy";

const DEFAULT_SLOT_MINUTES = 60; // temporary fallback until every service has slot_interval_minutes


// Phase 3: simple pluralization for tenant labels (A-mode: singular stored, plural derived)
function pluralizeLabel(singular: string): string {
  const w = String(singular || "").trim();
  if (!w) return "";
  const lower = w.toLowerCase();
  if (/(s|x|z|ch|sh)$/.test(lower)) return w + "es";
  if (/[^\s]y$/.test(lower) && !/[aeiou]y$/.test(lower)) return w.slice(0, -1) + "ies";
  return w + "s";
}


// ---- Birdie Design Tokens -----------------------------------------------

// --------------------------------------------------------------------------
// Component
// --------------------------------------------------------------------------

export default function PublicBookingPage({ __ssrTheme }: { __ssrTheme?: SsrThemeBootstrap }) {
  const params = useParams();
  const slug = (params?.slug as string) || "";
  const router = useRouter();

  // SSR bootstrap (PR-Theme-1): apply layout + tokens immediately, avoid client-side flashes.
  const layoutKey = __ssrTheme?.layoutKey || "";
  const themeTokens = __ssrTheme?.themeTokens || {};
  const brandOverrides = __ssrTheme?.brandOverrides || {};
  const bootstrapBranding = __ssrTheme?.branding || null;

  const { data: session } = useSession();

// Public booking pages can be visited without signing in.
// For customer-scoped endpoints we accept auth from:
// 1) NextAuth session tokens, OR
// 2) a locally stored Google id token (central auth) for custom domains.
const authToken: string | null =
  // NextAuth session (our callbacks expose snake_case keys)
  ((session as any)?.google_id_token as string | undefined) ||
  ((session as any)?.google_access_token as string | undefined) ||
  // Back-compat (older builds may have camelCase keys)
  ((session as any)?.googleIdToken as string | undefined) ||
  ((session as any)?.accessToken as string | undefined) ||
  // Central/localStorage token (for cross-domain flows)
  getStoredGoogleToken() ||
  null;

// Treat "signed in" as "we have a usable token".
const isSignedIn = !!authToken;


  // Phase C: detect silent Google logout and prevent ghost bookings.
  const [sessionExpired, setSessionExpired] = useState(false);

  // Phase D: tenant booking policy — require phone (tenant controlled, defaults to true)
  const initialRequirePhone =
    ((bootstrapBranding as any)?.require_phone ??
      (bootstrapBranding as any)?.requirePhone ??
      (bootstrapBranding as any)?.phone_required ??
      (bootstrapBranding as any)?.phoneRequired ??
      true) as boolean;
  const [requirePhoneFlag, setRequirePhoneFlag] = useState<boolean>(!!initialRequirePhone);

  useEffect(() => {
    setSessionExpired(false);
    if (!authToken) return;

    let cancelled = false;
    const ping = async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/customers/me/session?tenantSlug=${encodeURIComponent(slug)}`, {
          headers: {
            Authorization: `Bearer ${authToken}`,
          },
        });
        if (cancelled) return;
        if (res.status === 401) setSessionExpired(true);
      } catch {
        // ignore
      }
    };

    // ping now + every 4 minutes
    ping();
    const id = window.setInterval(ping, 4 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [authToken, slug]);

  const [view, setView] = useState<"booking" | "confirmation">("booking");

  const [confirmedBooking, setConfirmedBooking] = useState<{
    id: number;
    when: string;
    start: Date;
    durationMinutes: number;
    end?: Date;
    serviceName?: string | null;
    staffName?: string | null;
    resourceName?: string | null;
    status: string;

    // Invoice-style fields (optional)
    bookingCode?: string | null;
    createdAt?: string | null;
    customerName?: string | null;
    customerEmail?: string | null;
    customerPhone?: string | null;

    // membership receipt (optional)
    membershipPlanName?: string | null;
    membershipMinutesUsedForBooking?: number | null;
    membershipMinutesRemaining?: number | null;
    membershipUsesUsedForBooking?: number | null;
    membershipUsesRemaining?: number | null;
  } | null>(null);

  const [editingBooking, setEditingBooking] =
    useState<BookingHistoryItem | null>(null);

  const allowCustomerEdits = true; // TODO: make this tenant-configurable

  // NOTE: ledger modal should also lock scroll, so include it here
  const isModalOpen =
    view === "confirmation" || !!editingBooking /* ledger handled below */;

  // Phase D: phone onboarding modal (quick phone capture without hunting tabs)
  const [phoneOnboardingOpen, setPhoneOnboardingOpen] = useState(false);

// Phase G: membership checkout resolution modal (smart top-up / renew / strict)
const [membershipResolutionOpen, setMembershipResolutionOpen] = useState(false);
const [membershipResolution, setMembershipResolution] = useState<any | null>(null);
const [pendingBookingInput, setPendingBookingInput] = useState<CreateBookingInput | null>(null);
const [resolutionBusy, setResolutionBusy] = useState(false);

  const [phoneOnboardingDismissed, setPhoneOnboardingDismissed] = useState(false);

  // ------------------------------------------------------------
  // ✅ AUTH FIRST (so we have the real customer)
  // ------------------------------------------------------------
  const {
    customer,
    profileLoaded,
    autoUpsertDone,

    authName,
    setAuthName,
    authPhone,
    setAuthPhone,
    authEmail,
    setAuthEmail,

    authError,
    setAuthError,
    authSubmitting,

    handleCustomerAuthSubmit,
    handleLogoutCustomer,
  } = useCustomerAuth({
    slug,
    backendUrl: BACKEND_URL,
    session,
    // tenant-controlled policy (defaults to true)
    requirePhone: requirePhoneFlag,
    onLogout: () => {
    // hard reset of UI state on logout
    setActiveTab("home");
    setView("booking");
    setConfirmedBooking(null);
    setEditingBooking(null);
    setSelectedDate("");
    setServiceId("");
    setStaffId("");
    setResourceId("");
    setSelectedTimes([]);
    setSubmitError(null);
    },
    setView,
    setConfirmedBooking,
  });

function looksLikeExpiredAuth(err: any) {
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    msg.includes("401") ||
    msg.includes("unauthorized") ||
    msg.includes("token") && msg.includes("expired") ||
    msg.includes("jwt") && msg.includes("expired")
  );
}

async function handleCustomerAuthSubmitSafe(e: FormEvent) {
  try {
    await handleCustomerAuthSubmit(e as any);

    // Mark profile completion for this customer (prevents repeated redirects).
    try {
      const id = Number((customer as any)?.id || 0);
      if (id > 0 && typeof window !== "undefined") {
        localStorage.setItem(profileCompleteKey(slug, id), "1");
      }
    } catch {
      // ignore
    }

    // Close the phone onboarding modal after save (do not force tab switching).
    setPhoneOnboardingOpen(false);
    setPhoneOnboardingDismissed(true);
  } catch (err: any) {
    if (looksLikeExpiredAuth(err)) {
      setAuthError("Session expired. Please sign in again.");
      const returnUrl = `${window.location.origin}/book/${slug}`;
      redirectToCentralGoogleAuth(returnUrl);
      return;
    }
    setAuthError(err?.message || "Could not save profile.");
  }
}

async function handleLogoutCustomerSafe() {
  try {
    // try your hook logout (may call backend)
    await handleLogoutCustomer();
  } catch (err) {
    // ignore — we’ll force logout below
    console.warn("Logout via backend failed, forcing signOut()", err);
  } finally {
    // Force NextAuth logout no matter what
    await signOut({ callbackUrl: `/book/${slug}` });
  }
}
  
  // ------------------------------------------------------------
  // ✅ BOOKING HISTORY SECOND
  // ------------------------------------------------------------
  const {
    history,
    loadingHistory,
    historyError,
    cancellingId,
    loadHistory,
    cancelBooking,
} = useBookingHistory({
    slug,
    // IMPORTANT: do not auto-load history unless the visitor is authenticated.
    // We may have a cached customer in localStorage, but without a session the proxy correctly returns 401.
    customer: (isSignedIn && !sessionExpired ? ((customer as Customer | null) ?? null) : null),
    authToken: sessionExpired ? null : (authToken ?? null),
    sessionEmail: session?.user?.email,
    BACKEND_URL: BACKEND_URL,
    onCloseEditingBooking: () => setEditingBooking(null),
    onNeedEmail: () => {
      if (typeof window !== "undefined") {
        window.alert("Please add an email in your profile before cancelling.");
      }
    },
  });

  // ------------------------------------------------------------
  // Page data
  // ------------------------------------------------------------
  const {
    tenant,
    services,
    staff,
    resources,
    loading,
    error,
} = useTenantData({ slug, backendUrl: BACKEND_URL });

  // Phase D: if tenant disables phone requirement later, update the auth hook policy.
  useEffect(() => {
    const v =
      (tenant as any)?.settings?.require_phone ??
      (tenant as any)?.branding?.require_phone ??
      (tenant as any)?.branding?.requirePhone ??
      (bootstrapBranding as any)?.require_phone ??
      (bootstrapBranding as any)?.requirePhone ??
      (bootstrapBranding as any)?.phone_required ??
      (bootstrapBranding as any)?.phoneRequired ??
      true;

    setRequirePhoneFlag(!!v);
  }, [tenant, bootstrapBranding]);

  // Theme Studio / platform theme resolution (DB-driven)


// --------------------------------------------------------------------------
// Branding (tenants.branding JSONB) -> ThemeOverride mapping
// --------------------------------------------------------------------------
function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function isHexColor(v: any): v is string {
  return typeof v === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v.trim());
}

function darkenHex(hex: string, amount = 0.12) {
  // amount 0..1
  const h = hex.replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  const f = 1 - clamp(amount, 0, 1);
  const rr = Math.round(r * f);
  const gg = Math.round(g * f);
  const bb = Math.round(b * f);
  return `#${rr.toString(16).padStart(2, "0")}${gg.toString(16).padStart(2, "0")}${bb.toString(16).padStart(2, "0")}`;
}

function brandingToThemeOverride(branding: any): ThemeOverride | null {
  if (!branding || typeof branding !== "object") return null;

  const colors = branding.colors || {};
  const buttons = branding.buttons || {};

  const primary = isHexColor(colors.primary) ? colors.primary : null;
  const background = isHexColor(colors.background) ? colors.background : null;
  const surface = isHexColor(colors.surface) ? colors.surface : null;
  const text = isHexColor(colors.text) ? colors.text : null;
  const mutedText = isHexColor(colors.mutedText) ? colors.mutedText : null;
  const border = isHexColor(colors.border) ? colors.border : null;

  const radiusRaw = typeof buttons.radius === "number" ? buttons.radius : null;
  const radius = radiusRaw == null ? null : clamp(radiusRaw, 0, 30);

  const o: ThemeOverride = {};

  if (primary) {
    o.brand = {
      primary,
      primaryDark: darkenHex(primary, 0.18),
    };
    o.pill = {
      bgSelected: primary,
      border: border ?? undefined,
    };
  }

  if (background) o.page = { ...(o.page || {}), bg: background };
  if (surface || border || radius != null) {
    o.card = {
      ...(o.card || {}),
      ...(surface ? { bg: surface } : {}),
      ...(border ? { borderSubtle: border } : {}),
      ...(radius != null ? { radius } : {}),
    };
  }

  if (text || mutedText) {
    o.text = {
      ...(o.text || {}),
      ...(text ? { main: text } : {}),
      ...(mutedText ? { muted: mutedText, soft: mutedText } : {}),
    };
    if (text) o.pill = { ...(o.pill || {}), text: text };
  }

  // Only return override if we actually mapped anything
  return Object.keys(o).length ? o : null;
}

function mergeThemeOverrides(a: ThemeOverride | null, b: ThemeOverride | null): ThemeOverride | null {
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;

  return {
    brand: { ...(a.brand || {}), ...(b.brand || {}) },
    page: { ...(a.page || {}), ...(b.page || {}) },
    card: { ...(a.card || {}), ...(b.card || {}) },
    text: { ...(a.text || {}), ...(b.text || {}) },
    pill: { ...(a.pill || {}), ...(b.pill || {}) },
  };
}function layoutPresetOverride(layoutName?: string): ThemeOverride | null {
  const key = (layoutName || "").toLowerCase();
  if (key !== "premium") return null;

  	// Premium (dark glass) preset — aligns with app/book/design/premium/premium1.module.css
	// BUT: accent colors come from brand vars so Theme Studio can control them.
	return {
	  page: { bg: "var(--bf-page-bg, #020617)" },
	
	  card: {
	    bg: "var(--bf-card-bg, rgba(2, 6, 23, 0.46))",
	    borderSubtle: "var(--bf-card-border, rgba(255,255,255,0.10))",
	    radius: 20,
	  },
	
	  text: {
	    main: "var(--bf-text-main, rgba(255,255,255,0.92))",
	    muted: "var(--bf-text-muted, rgba(255,255,255,0.72))",
	    soft: "var(--bf-text-soft, rgba(255,255,255,0.72))",
	  },
	
	  pill: {
	    bg: "var(--bf-pill-bg, rgba(255,255,255,0.06))",
	
	    // ✅ Accent comes from brand primary (Theme Studio)
	    // Uses color-mix so it becomes a translucent version of the brand color.
	    bgSelected:
	      "var(--bf-pill-selected-bg, color-mix(in srgb, var(--bf-brand-primary, #22c55e) 18%, transparent))",
	
	    bgDisabled: "var(--bf-pill-disabled-bg, rgba(255,255,255,0.03))",
	    border: "var(--bf-pill-border, rgba(255,255,255,0.14))",
	    text: "var(--bf-pill-text, rgba(255,255,255,0.90))",
	    textSelected: "var(--bf-pill-selected-text, rgba(255,255,255,0.92))",
	    textDisabled: "var(--bf-pill-disabled-text, rgba(255,255,255,0.38))",
	
	    // ✅ Accent ring comes from brand primary as well
	    shadowSelected:
	      "var(--bf-pill-selected-shadow, 0 0 0 4px color-mix(in srgb, var(--bf-brand-primary, #22c55e) 14%, transparent))",
	  },
	};
}

// --------------------------------------------------------------------------
// Theme (default + tenant overrides)
// --------------------------------------------------------------------------
const theme: Theme = useMemo(() => {
  const legacyOverrides =
    (tenant as any)?.theme ??
    (tenant as any)?.theme_overrides ??
    (tenant as any)?.theme_settings ??
    null;

  
const brandingOverrides = brandingToThemeOverride((tenant as any)?.branding);

// 2) Published platfrom theme's layout_key from SSR (Theme Studio)
const layoutName = normalizeLayoutName(layoutKey || "classic") || "classic";

const presetOverrides = layoutPresetOverride(layoutName);

const merged1 = mergeThemeOverrides(legacyOverrides as ThemeOverride | null, brandingOverrides);
const overrides = mergeThemeOverrides(merged1, presetOverrides);

return resolveTheme(defaultTheme, overrides as ThemeOverride | null);
}, [tenant, layoutKey]);

  // Backwards-compatible tokens used throughout this page and child components
  const BIRDIE_GREEN = theme.brand.primary;
  const BIRDIE_GREEN_DARK = theme.brand.primaryDark;
  const PAGE_BG = theme.page.bg;


  // Backwards-compatible tokens used in this page
  const TEXT_MAIN = theme.text.main;
  const TEXT_MUTED = theme.text.muted;
  const TEXT_SOFT = theme.text.soft;
  const BORDER_SUBTLE = theme.card.borderSubtle;
  const CARD_BG = theme.card.bg;


  // NOTE: CSS variables are injected by <TenantCssVarsProvider />.
  // Do not also write to documentElement here, or Theme Studio overrides
  // will be overwritten after render.

  // bottom nav / tabs (Book, Reservations, My account, Home)
  const [activeTab, setActiveTab] = useState<ActiveTab>("home");

  // ------------------------------------------------------------------------
  // Phase E: Phone onboarding modal (source of truth = DB customer record)
//
// Desired behavior:
// - If tenant requires phone and the signed-in customer's DB record is missing required fields,
//   prompt via a modal (NOT via the My Account tab).
// - If the customer already has a valid phone in the DB, they should NOT be prompted.
// - Once completed, the modal should not keep re-appearing for that customer.
// ------------------------------------------------------------------------
function profileCompleteKey(tenantSlug: string, customerId: number) {
  return `bf_profile_complete_${tenantSlug}_${customerId}`;
}

  // Home: "next booking" details modal
  const [homeNextOpen, setHomeNextOpen] = useState(false);

  const navItems: NavItem[] = [
    { key: "home", label: "Home", icon: "🏠", iconSrc: "/nav-home.png" },
    { key: "book", label: "Book", icon: "📅", iconSrc: "/nav-book.png" },
    {
      key: "history",
      label: "Reservations",
      icon: "📋",
      iconSrc: "/nav-history.png",
    },
    {
      key: "memberships",
      label: "Memberships",
      icon: "🎟️",
      iconSrc: "/nav-memberships.png",
    },
    {
      key: "account",
      label: "My account",
      icon: "👤",
      iconSrc: "/nav-account.png",
    },
  ];

  // form state
  const [serviceId, setServiceId] = useState<number | "">("");

  // Phase 3: service -> allowed staff/resources filtering (safe fallback)
  const [serviceLinkFilter, setServiceLinkFilter] = useState<{
    staff: { mode: "all" | "linked"; ids: number[] };
    resources: { mode: "all" | "linked"; ids: number[] };
    loading: boolean;
    error: string | null;
  }>({ staff: { mode: "all", ids: [] }, resources: { mode: "all", ids: [] }, loading: false, error: null });
  const [staffId, setStaffId] = useState<number | "">("");
  const [resourceId, setResourceId] = useState<number | "">("");
  const [selectedDate, setSelectedDate] = useState<string>(""); // YYYY-MM-DD
  const [selectedTimes, setSelectedTimes] = useState<string[]>([]); // HH:MM[]
  const [submitting, setSubmitting] = useState(false);
  const [useMembershipCredits, setUseMembershipCredits] = useState(false);

  const [submitError, setSubmitError] = useState<string | null>(null);

  
  const tenantRequirePhone: boolean =
    (tenant as any)?.settings?.require_phone ??
    (tenant as any)?.branding?.require_phone ??
    (bootstrapBranding as any)?.require_phone ??
    true;

  const isProfileComplete = (c: any) =>
    !!String(c?.name || "").trim() &&
    !!String(c?.email || "").trim() &&
    (!tenantRequirePhone || !!String(c?.phone || "").trim());

  // Phase E: If this is the first time we see this customer missing required
// fields, drive them to the Account tab (one-time per customer per tenant).
//
// Important: wait until the profile sync finishes (profileLoaded) so we don't
// mis-route existing users due to stale cached customer objects.
useEffect(() => {
  if (typeof window === "undefined") return;
  if (!tenantRequirePhone) return;
  if (!isSignedIn || sessionExpired) return;
  if (!profileLoaded) return;

  const customerId = (customer as any)?.id ? Number((customer as any).id) : null;

  // Wait until the first server hydration/upsert attempt finishes before deciding.
  // This avoids flashing the modal for existing users while their DB record is loading.
  if (!customerId && !autoUpsertDone) return;

  // Source of truth: the DB customer record.
  // If we have a customer record and it already satisfies required fields, do nothing.
  if (customerId && customer && isProfileComplete(customer)) return;

  // No customer record yet (brand new user) or customer record is missing required fields.
  // Use a stable key to avoid repeated prompting.
  const identityKey = (authEmail || "").trim().toLowerCase();
  if (!customerId && !identityKey) return;

  const completionKey = customerId
    ? profileCompleteKey(slug, customerId)
    : `bf_profile_complete_${slug}_email_${identityKey}`;

  const alreadyCompleted = localStorage.getItem(completionKey) === "1";
  if (alreadyCompleted) return;
  if (phoneOnboardingDismissed) return;

  setPhoneOnboardingOpen(true);
}, [tenantRequirePhone, isSignedIn, sessionExpired, profileLoaded, autoUpsertDone, customer, authEmail, slug, phoneOnboardingDismissed]);

  const {
    // Expose the internal loader so we can refresh membership balance after a booking succeeds
    // (without requiring a full page refresh)
    loadCustomerMemberships,

    subscribingPlanId,
    subscribeToPlan,

    ledgerOpenFor,
    setLedgerOpenFor,
    ledgerItems,
    loadingLedger,
    ledgerError,
    openLedger,
    closeLedger,
  } = useMemberships({
    slug,
    // Only load customer memberships when authenticated.
    customerId: (isSignedIn && !sessionExpired) ? ((customer as any)?.id ?? null) : null,
    authToken: sessionExpired ? null : (authToken ?? null),
    autoLoadMemberships: isSignedIn && !sessionExpired,
  });

  // ------------------------------------------------------------------------
  // Phase 4D: Customer-scoped live refresh (cheap version gate)
  //
  // Polls /api/customers/me/versions ONLY when History or Memberships is visible.
  // If a version changes, we refetch the real data (history/memberships).
  // ------------------------------------------------------------------------
  useCustomerVersionsGate({
    slug,
    enabled:
      (activeTab === "history" || activeTab === "memberships") &&
      isSignedIn &&
      !sessionExpired &&
      !!authToken &&
      !!(customer as any)?.id,
    authToken,
    onBookingsChanged: async () => {
      if (activeTab !== "history") return;
      if (!customer) return;
      await loadHistory(customer as any, { silent: true });
    },
    onMembershipsChanged: async () => {
      if (activeTab !== "memberships") return;
      await loadCustomerMemberships();
    },
  });

  // Treat ledger as a modal for scroll lock
  const isAnyModalOpen = isModalOpen || !!ledgerOpenFor;

  useEffect(() => {
    if (typeof document === "undefined") return;

    document.body.style.overflow = isAnyModalOpen ? "hidden" : "";

    return () => {
      document.body.style.overflow = "";
    };
  }, [isAnyModalOpen]);

  const selectedService = useMemo(
    () => services.find((s) => s.id === serviceId),
    [services, serviceId]
  );

  // PR-LP6: About auto-sections (Home tab only). Read-only derived content.
  const landingAboutSections = useMemo(() => {
    try {
      return buildLandingAboutSections({
        tenant,
        services,
        resources,
        membershipPlans,
      });
    } catch {
      return [];
    }
  }, [tenant, services, resources, membershipPlans]);

  const requiresStaff = !!selectedService?.requires_staff;
  const requiresResource = !!selectedService?.requires_resource;


  // Phase 3: load allowed staff/resources when service changes
  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!serviceId || serviceId === ("" as any)) {
        setServiceLinkFilter((prev) => ({ ...prev, staff: { mode: "all", ids: [] }, resources: { mode: "all", ids: [] }, loading: false, error: null }));
        return;
      }
      setServiceLinkFilter((prev) => ({ ...prev, loading: true, error: null }));
      try {
        const res = await fetch(`/api/proxy/links/service?tenantSlug=${encodeURIComponent(slug)}&serviceId=${encodeURIComponent(String(serviceId))}`, {
          method: "GET",
          cache: "no-store",
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((json as any)?.error || `Failed to load links (HTTP ${res.status})`);

        const staffObj = (json as any)?.staff || { mode: "all", ids: [] };
        const resObj = (json as any)?.resources || { mode: "all", ids: [] };

        if (cancelled) return;
        setServiceLinkFilter({
          staff: { mode: staffObj.mode === "linked" ? "linked" : "all", ids: Array.isArray(staffObj.ids) ? staffObj.ids : [] },
          resources: { mode: resObj.mode === "linked" ? "linked" : "all", ids: Array.isArray(resObj.ids) ? resObj.ids : [] },
          loading: false,
          error: null,
        });
      } catch (e: any) {
        if (cancelled) return;
        setServiceLinkFilter((prev) => ({ ...prev, loading: false, error: e?.message || "Failed to load service links" }));
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [slug, serviceId]);



  // Phase 3: tenant terminology (A-mode: singular stored, plural derived)
  const staffLabelSingular = String((tenant as any)?.branding?.terminology?.staffLabelSingular || (tenant as any)?.branding?.terminology?.staff_label_singular || "Staff").trim() || "Staff";
  const resourceLabelSingular = String((tenant as any)?.branding?.terminology?.resourceLabelSingular || (tenant as any)?.branding?.terminology?.resource_label_singular || "Resource").trim() || "Resource";
  
  // --- Membership eligibility (public booking) ---------------------------
  // We separate two ideas:
  // 1) Should we *show* the membership toggle? (signed in + service eligible)
  // 2) Is there actually a usable balance to debit? (active, not expired, >0)
  //
  // This avoids the UX failure mode where a signed-in customer on an eligible
  // service sees *no checkbox at all* simply because membership data is still
  // loading / temporarily empty.
  const membershipServiceEligible = (() => {
    // Backwards compatibility:
    // If `allow_membership` is missing/undefined in older payloads, treat as eligible.
    if (!serviceId) return false;
    const allowMembership = (selectedService as any)?.allow_membership;
    return allowMembership !== false;
  })();

  const showMembershipToggle = Boolean(isSignedIn && membershipServiceEligible);

  const hasUsableMembershipBalance = (() => {
    if (!customerMemberships || customerMemberships.length === 0) return false;
    const now = Date.now();
    return customerMemberships.some((m: any) => {
      const statusOk = !m?.status || String(m.status).toLowerCase() === "active";
      const endAt = m?.end_at ? new Date(m.end_at).getTime() : null;
      const notExpired = !endAt || endAt > now;
      const mins = Number(m?.minutes_remaining ?? m?.minutesRemaining ?? 0);
      const uses = Number(m?.uses_remaining ?? m?.usesRemaining ?? 0);
      return statusOk && notExpired && (mins > 0 || uses > 0);
    });
  })();

  // UI toggle visibility (checkbox shown) — *not* the same as balance sufficiency.
  const canUseMembershipEntitlement = showMembershipToggle;

  // Toggle interactivity + helper text
  // The checkbox can be shown (entitlement) but disabled while we determine balance.
  const membershipToggleDisabled =
    !showMembershipToggle ||
    !!loadingMemberships ||
    !!membershipsError ||
    !hasUsableMembershipBalance;

  const membershipToggleHint = (() => {
    if (!showMembershipToggle) return "";
    if (loadingMemberships) return "Checking membership balance…";
    if (membershipsError) return "Could not load memberships.";
    if (!hasUsableMembershipBalance) return "No membership credits available.";
    return "";
  })();

  // If memberships become unavailable (logout/expired), drop the toggle safely.
  useEffect(() => {
    // If the toggle is no longer available (logout / service becomes ineligible), drop it safely.
    if (!showMembershipToggle && useMembershipCredits) {
      setUseMembershipCredits(false);
    }
    // If customer has no usable balance, also force-disable (prevents backend debit failures).
    if (showMembershipToggle && !hasUsableMembershipBalance && useMembershipCredits) {
      setUseMembershipCredits(false);
    }
  }, [showMembershipToggle, hasUsableMembershipBalance, useMembershipCredits]);

const filteredStaff = useMemo(() => {
    if (serviceLinkFilter.staff.mode !== "linked") return staff;
    const allowed = new Set(serviceLinkFilter.staff.ids.map((x) => Number(x)));
    return staff.filter((s) => allowed.has(Number((s as any).id)));
  }, [staff, serviceLinkFilter.staff.mode, serviceLinkFilter.staff.ids]);

  const filteredResources = useMemo(() => {
    if (serviceLinkFilter.resources.mode !== "linked") return resources;
    const allowed = new Set(serviceLinkFilter.resources.ids.map((x) => Number(x)));
    return resources.filter((r) => allowed.has(Number((r as any).id)));
  }, [resources, serviceLinkFilter.resources.mode, serviceLinkFilter.resources.ids]);

  // ---- Slot rules (service-driven) --------------------------------------
  // Interval defaults to SLOT_MINUTES when not configured on the service
  const intervalMinutes =
    Number(selectedService?.slot_interval_minutes) || DEFAULT_SLOT_MINUTES;
	
  // Service duration_minutes is the *base* duration (minimum booking duration)
  const baseDurationMinutes =
    Number((selectedService as any)?.duration_minutes ?? intervalMinutes) ||
    intervalMinutes;

  const minSlots = Math.max(
    1,
    Math.ceil(baseDurationMinutes / intervalMinutes)
  );

  const maxSlots = Math.max(
    minSlots,
    Number((selectedService as any)?.max_consecutive_slots ?? minSlots) ||
      minSlots
  );

  const selectedDurationMinutes = selectedTimes.length * intervalMinutes;

  // Single source of truth: enforce contiguous selection + max slots
  const handleToggleSlot = (time: string) => {
    setSubmitError(null);

    setSelectedTimes((prev) => {
      const sorted = [...prev].sort();
      const already = sorted.includes(time);

      // Removing: only allow removing from edges (prevents breaking contiguity)
      if (already) {
        const first = sorted[0];
        const last = sorted[sorted.length - 1];
        if (time !== first && time !== last) {
          setSubmitError(
            "Please remove slots from the ends (keep it consecutive)."
          );
          return prev;
        }
        return sorted.filter((t) => t !== time);
      }

      // Adding
      if (sorted.length >= maxSlots) {
        setSubmitError(
          `You can select up to ${maxSlots} slot(s) for this service.`
        );
        return prev;
      }

      const next = [...sorted, time].sort();

      if (!isContiguousSelection(next, timeSlots)) {
        setSubmitError("Please select consecutive time slots.");
        return prev;
      }

      return next;
    });
  };
  
  const { createBooking } = useCreateBooking();
  
  // When the date changes, clear service, staff, resource + time slots
  useEffect(() => {
    setServiceId("");
    setStaffId("");
    setResourceId("");
    setSelectedTimes([]);
  }, [selectedDate]);

  // Phase D: keep user in the flow — show a quick phone modal instead of forcing a tab switch.
  useEffect(() => {
    if (activeTab !== "book") return;
    if (!isSignedIn || sessionExpired) return;
    if (!customer) return;
    if (isProfileComplete(customer)) return;
    if (phoneOnboardingDismissed) return;
    setPhoneOnboardingOpen(true);
  }, [activeTab, isSignedIn, sessionExpired, customer, phoneOnboardingDismissed]);

  // ---- Availability is handled by the shared hook ------------------------
  const { timeSlots, loadingSlots, availabilityError } = useAvailability({
    backendUrl: BACKEND_URL,
    tenantSlug: slug,
    selectedDate,
    serviceId,
    staffId,
    resourceId,
    requiresStaff,
    requiresResource,
  });

  // ---- Cancel booking ----------------------------------------------------
  const handleCancelBooking = (id: number) => {
    setEditingBooking(null);
    cancelBooking(id);
  };

  
// ---- Submit booking ----------------------------------------------------

function acceptBookingResponse(resp: any, durationMinutesFallback: number) {
  if (!resp?.booking) return false;

  const b = resp.booking;

  const start = new Date(b.start_time);
  if (Number.isNaN(start.getTime())) {
    console.error("Invalid start_time returned from API", b.start_time, b);
    setSubmitError("Booking succeeded, but the server returned an invalid time. Please refresh.");
    return false;
  }

  const durationSafe = Number(b.duration_minutes ?? durationMinutesFallback);
  const end = new Date(start.getTime() + durationSafe * 60 * 1000);
  if (Number.isNaN(end.getTime())) {
    console.error("Invalid end time computed", { start, durationSafe, booking: b });
    setSubmitError("Booking succeeded, but we couldn’t compute the end time. Please refresh.");
    return false;
  }

  setConfirmedBooking({
    id: b.id,
    when: new Date(b.start_time).toLocaleString(),
    start,
    durationMinutes: durationSafe,
    end,
    serviceName: b.service_name,
    staffName: b.staff_name,
    resourceName: b.resource_name,
    status: b.status,

    // invoice fields
    bookingCode: b.booking_code ?? null,
    createdAt: b.created_at ?? null,
    customerName: b.customer_name ?? null,
    customerEmail: b.customer_email ?? null,
    customerPhone: b.customer_phone ?? null,

    // membership receipt (optional)
    membershipPlanName: (b as any).membership_plan_name ?? null,
    membershipMinutesUsedForBooking: (b as any).membership_minutes_used_for_booking ?? null,
    membershipMinutesRemaining: (b as any).membership_minutes_remaining ?? null,
    membershipUsesUsedForBooking: (b as any).membership_uses_used_for_booking ?? null,
    membershipUsesRemaining: (b as any).membership_uses_remaining ?? null,
  });

  setView("confirmation");
  return true;
}

async function handleSubmit(e: FormEvent) {
  e.preventDefault();
  setSubmitError(null);
  setConfirmedBooking(null);

  // Phase C: booking confirmation requires a live auth session.
  if (!authToken || !isSignedIn || sessionExpired) {
    setSubmitError("Please sign in to confirm your booking.");
    const returnUrl = `${window.location.origin}/book/${slug}`;
    redirectToCentralGoogleAuth(returnUrl);
    return;
  }

  // Guardrails
  if (!customer || !isProfileComplete(customer)) {
    setSubmitError("Please complete your profile before booking.");
    setPhoneOnboardingOpen(true);
    setPhoneOnboardingDismissed(false);
    return;
  }
  if (!selectedDate) {
    setSubmitError("Please pick a date.");
    return;
  }
  if (!serviceId) {
    setSubmitError("Please select a service.");
    return;
  }
  if (selectedTimes.length == 0) {
    setSubmitError("Please select at least one time slot.");
    return;
  }
  if (requiresStaff && !staffId) {
    setSubmitError("This service requires selecting a staff member.");
    return;
  }
  if (requiresResource && !resourceId) {
    setSubmitError("This service requires selecting a resource.");
    return;
  }

  let bookingInput: CreateBookingInput | null = null;

  try {
    setSubmitting(true);

    const firstTime = [...selectedTimes].sort()[0];
    const startLocal = new Date(`${selectedDate}T${firstTime}:00`);
    const startTimeISO = startLocal.toISOString();
    const durationMinutes = selectedTimes.length * intervalMinutes;

    bookingInput = {
      backendUrl: BACKEND_URL,
      authToken,
      tenantSlug: slug,
      startTimeISO,
      durationMinutes,

      customerId: (customer as any).id,
      customerName: customer.name,
      customerPhone: customer.phone ?? null,
      customerEmail: customer.email ?? session?.user?.email ?? null,

      serviceId: serviceId ? Number(serviceId) : null,
      staffId: staffId ? Number(staffId) : null,
      resourceId: resourceId ? Number(resourceId) : null,

      requiresStaff,
      requiresResource,

      status: "confirmed",

      // Phase 2: membership consumption (optional)
      autoConsumeMembership: !!useMembershipCredits,
      // If the user explicitly checked "Use membership credits", treat it as a hard requirement.
      // This prevents the system from silently booking WITHOUT debiting credits.
      requireMembership: !!useMembershipCredits,
    };

    const resp = await createBooking(bookingInput);

    if (!acceptBookingResponse(resp, durationMinutes)) {
      // acceptBookingResponse sets an appropriate submitError if needed
      return;
    }

    // Refresh derived tabs after a successful booking:
    // - Booking History tab (so latest booking appears without a full page refresh)
    // - Membership tab (so balance reflects any membership debit)
    try {
      await Promise.allSettled([
        // Booking history loader needs the customer context
        loadHistory(customer, { silent: true }),
        // Memberships loader is already customer-scoped internally
        loadCustomerMemberships(),
      ]);
    } catch {
      // ignore refresh errors — booking already succeeded
    }
  } catch (err: any) {
    const payload = err?.payload || null;
    const apiErr = String(payload?.error || "").toLowerCase();

    // Smart membership resolution (409 from backend)
    if (err?.status === 409 && apiErr === "membership_insufficient_balance" && payload?.resolution) {
      setMembershipResolution(payload.resolution);
      // store the exact attempt so we can retry after top-up / choose another path
      if (bookingInput) setPendingBookingInput(bookingInput);
      setMembershipResolutionOpen(true);

      // Don't show the generic red error yet — the modal is the UX.
      return;
    }

    setSubmitError(err?.message || "Booking failed.");
  } finally {
    setSubmitting(false);
  }
}

// ---- UI ----------------------------------------------------------------
// Single source of truth for booking layout:
//  1) Published theme layout_key from SSR (__ssrTheme.layoutKey)
const ssrLayout = normalizeLayoutName(layoutKey || "") || "classic";
const isPremium = ssrLayout === "premium" || ssrLayout === "premium_light";
const Layout = getBookingLayout(ssrLayout);

const tabBannerSrc = (() => {
  if (!tenant) return null;
  // Birdie Premium prototype uses the "account" banner image for the booking hero.
  // Keep the normal mapping for non-premium layouts.
  if (activeTab === "book") {
    if (isPremium) return tenant.banner_account_url || tenant.banner_book_url || null;
    return tenant.banner_book_url || null;
  }
  if (activeTab === "history") return tenant.banner_reservations_url || null;
  if (activeTab === "account") return tenant.banner_account_url || null;
  if (activeTab === "home") return tenant.banner_home_url || null;
  return null;
})();

const ssrTabBannerSrc = (() => {
  const b = (bootstrapBranding as any)?.assets?.banners || {};
  // Keep parity with tabBannerSrc mapping (including the premium booking-hero preference).
  if (activeTab === "book") {
    if (isPremium) return b.accountUrl || b.bookUrl || null;
    return b.bookUrl || null;
  }
  if (activeTab === "history") return b.reservationsUrl || null;
  if (activeTab === "account") return b.accountUrl || null;
  if (activeTab === "home") return b.homeUrl || null;
  return null;
})();

const firstNonEmpty = (...values: Array<string | null | undefined>) =>
  values.find((v) => typeof v === "string" && v.trim().length > 0) || null;

// Priority (to eliminate the "default banner flash"):
//  1) SSR branding hero (already known at first paint)
//  2) SSR per-tab banner (already known at first paint)
//  3) explicit tenant branding hero (client-fetched)
//  4) per-tab banner from tenants table (client-fetched)
//  5) tenant cover image (client-fetched)
//  6) fallback (must exist in /public)
const heroImageSrc =
  firstNonEmpty(
    (bootstrapBranding as any)?.assets?.heroUrl,
    ssrTabBannerSrc,
    (tenant as any)?.branding?.assets?.heroUrl,
    tabBannerSrc,
    tenant?.cover_image_url,
    null
  ) || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'%3E%3C/svg%3E";

const heroLabel = "Online booking";
const heroTitle = tenant?.name || "Book a session";

const memberSinceLabel =
  (customer as any)?.created_at
    ? new Date((customer as any).created_at).toLocaleDateString()
    : null;

const avatarInitials = customer?.name ? initialsFromName(customer.name) : "";

const HeaderText = () => (
  <div style={{ marginBottom: 8 }}>
    <div style={{ fontSize: "var(--bf-type-heading-fs)", fontWeight: "var(--bf-type-heading-fw)", color: TEXT_MAIN }}>
      Book your time
    </div>
    <div style={{ fontSize: "var(--bf-type-caption-fs)", color: TEXT_MUTED, marginTop: 2 }}>
      Choose a date, then pick consecutive time slots.
    </div>
  </div>
);

const logoSrc =
  (tenant as any)?.branding?.assets?.logoUrl || tenant?.logo_url || "/birdielogo.png";

// When premium is active, render the same hero shell as the prototype page
// (black glass / no green strip), while still using the tenant's real hero + logo URLs.
const hero = isPremium ? (
  <header className={premiumStyles.hero}>
    <div className={premiumStyles.heroMedia} aria-hidden="true">
      <Image
        src={heroImageSrc}
        alt=""
        fill
        priority
        sizes="100vw"
        className={premiumStyles.heroImg}
      />
      <div className={premiumStyles.heroOverlay} />
    </div>

    <div className={premiumStyles.heroInner}>
      <div className={premiumStyles.brandText}>
        <div className={premiumStyles.logoRow}>
          <div className={premiumStyles.logoWrap}>
            <Image
              src={logoSrc}
              alt={tenant?.name || "Logo"}
              fill
              priority
              sizes="220px"
              className={premiumStyles.logoImg}
            />
          </div>
        </div>
        <div className={premiumStyles.brandEyebrow}>ONLINE BOOKING</div>
      </div>
    </div>
  </header>
) : (
  <HeroBanner
    heroImageSrc={heroImageSrc}
    heroLabel={heroLabel}
    heroTitle={heroTitle}
    venueNameFallback={tenant?.name}
    logoSrc={logoSrc}
    memberSinceLabel={memberSinceLabel}
    avatarInitials={avatarInitials}
    backgroundColor={BIRDIE_GREEN_DARK}
  />
);

const content = (
  <div
    style={
      isPremium
        ? {
            width: "100%",
            display: "flex",
            flexDirection: "column",
            flex: "0 0 auto",
          }
        : {
            maxWidth: 920,
            margin: "0 auto",
            width: "100%",
            display: "flex",
            flexDirection: "column",
            flex: "0 0 auto",
          }
    }
  >
    {/* NOTE: Keep the page behaving like a real app sheet:
        - no forced inner scrolling
        - the card grows naturally when dropdowns/images expand
        - the page only becomes scrollable if the content exceeds the viewport */}
    <div
      style={{
        flex: "0 0 auto",
        marginTop: 12,
        paddingBottom: 24,
      }}
    >
        {/* BOOK TAB */}
        {activeTab === "book" && (
          <>
            {isPremium ? null : <HeaderText />}

            {!loading && error && (
              <div
                style={{
                  marginBottom: "var(--bf-alert-mb, 16px)",
                  padding: "var(--bf-alert-pad-y, 10px) var(--bf-alert-pad-x, 10px)",
                  borderRadius: "var(--bf-alert-radius, 8px)",
                  background: "var(--bf-alert-error-bg, #fee2e2)",
                  color: "var(--bf-alert-error-text, #b91c1c)",
                  border: "1px solid var(--bf-alert-error-border, rgba(185, 28, 28, 0.25))",
                  fontSize: "var(--bf-alert-fs, var(--bf-type-body-fs))",
                }}
              >
                ⚠ {error}
              </div>
            )}

            {!loading && !error && services.length === 0 && (
              <div
                style={{
                  marginTop: "var(--bf-alert-mt, 12px)",
                  padding: "var(--bf-alert-pad-y, 10px) var(--bf-alert-pad-x, 10px)",
                  borderRadius: "var(--bf-alert-radius, 8px)",
                  background: "var(--bf-alert-warn-bg, #fffbeb)",
                  color: "var(--bf-alert-warn-text, #92400e)",
                  border: "1px solid var(--bf-alert-warn-border, rgba(146, 64, 14, 0.25))",
                  fontSize: "var(--bf-alert-fs, var(--bf-type-body-fs))",
                }}
              >
                No services are configured yet for this business.
              </div>
            )}

            {/* Gate the actual booking form behind profile completeness */}
            {!loading && customer && isProfileComplete(customer) ? (
              <BookingFormCard
                isPremium={isPremium}
                customerExists={!!customer}
                loading={loading}
                error={error}
                activeTab={activeTab}
                view={view}
                selectedDate={selectedDate}
                serviceId={serviceId}
                staffId={staffId}
                resourceId={resourceId}
                selectedTimes={selectedTimes}
                submitError={submitError}
                submitting={submitting}
                canUseMembership={canUseMembershipEntitlement}
                membershipToggleDisabled={membershipToggleDisabled}
                membershipToggleHint={membershipToggleHint}
                useMembershipCredits={useMembershipCredits}
                setUseMembershipCredits={setUseMembershipCredits}
                services={services}
                staff={filteredStaff}
                resources={filteredResources}
                selectedService={selectedService}
                requiresStaff={!!selectedService?.requires_staff}
                requiresResource={!!selectedService?.requires_resource}
                timeSlots={timeSlots}
                loadingSlots={loadingSlots}
                availabilityError={availabilityError}
                onSubmit={handleSubmit}
                setSelectedDate={setSelectedDate}
                setServiceId={setServiceId}
                setStaffId={setStaffId}
                setResourceId={setResourceId}
                setSelectedTimes={setSelectedTimes}
                setSubmitError={setSubmitError}
                formatLocalDate={formatLocalDate}
				intervalMinutes={intervalMinutes}
				minSlots={minSlots}
				maxSlots={maxSlots}
				selectedDurationMinutes={selectedDurationMinutes}
				onToggleSlot={handleToggleSlot}
				showServiceMeta={Boolean((tenant as any)?.branding?.bookingUi?.showServiceMeta ?? true)}
              />
            ) : loading ? (
              <p style={{ fontSize: "var(--bf-type-body-fs)", color: TEXT_MUTED }}>
                Loading services...
              </p>
            ) : (
              <p style={{ fontSize: "var(--bf-type-body-fs)", color: TEXT_MUTED }}>
                Tap the profile icon in the banner to enter your details. Once
                that&apos;s done, you&apos;ll see the booking form here.
              </p>
            )}

            <ConfirmationModal
              isOpen={view === "confirmation"}
              loading={loading}
              error={error}
              servicesCount={services.length}
              customerExists={!!customer}
              confirmedBooking={confirmedBooking}
              onBookAnother={() => {
                setConfirmedBooking(null);
                setSelectedDate("");
                setServiceId("");
                setStaffId("");
                setResourceId("");
                setSelectedTimes([]);
                setSubmitError(null);
                setView("booking");
              }}            />

            {!loading && !error && services.length > 0 && !customer && (
              <p style={{ marginTop: 8, fontSize: "var(--bf-type-caption-fs)", color: TEXT_MUTED }}>
                You can browse availability without signing in. To confirm a
                booking, please sign in from the Account tab.
              </p>
            )}
          </>
        )}

        {/* HOME TAB */}
        {activeTab === "home" && (() => {
          const b = (tenant as any)?.branding || {};
          const offers = (() => {
            const raw = b?.offers ?? b?.promos ?? b?.promo_lines ?? b?.offer_lines;
            if (Array.isArray(raw)) return raw as string[];
            if (typeof raw === "string" && raw.trim()) {
              return raw
                .split(/\r?\n|\s*\|\s*/g)
                .map((x) => x.trim())
                .filter(Boolean);
            }
            const single = b?.promo_text ?? b?.promoText ?? b?.offer_text ?? b?.offerText;
            if (typeof single === "string" && single.trim()) return [single.trim()];
            return [];
          })();

          const next = (() => {
            const items = Array.isArray(history) ? history : [];
            const now = Date.now();
            const upcoming = items
              .map((h: any) => {
                const t = new Date(h.start_time || h.startTime || h.when || 0).getTime();
                return { h, t };
              })
              .filter((x) => Number.isFinite(x.t) && x.t >= now)
              .sort((a, b) => a.t - b.t)[0];
            if (!upcoming) return null;
            const h = upcoming.h;
            const when = new Date(h.start_time || h.startTime).toLocaleString();
            return {
              when,
              service: h.service_name || h.serviceName || null,
            };
          })();

          // PR-LP10: "SaaS layout rhythm" — wire real signals + lightweight previews into Home.
          // This eliminates the "random grey pills" feeling when data is already available.
          const homeSignals = (() => {
            const items: { key: string; label: string }[] = [];

            const serviceCount = Array.isArray(services) ? services.length : 0;
            if (serviceCount > 0) items.push({ key: "services", label: `${serviceCount} services` });

            const resourceCountRaw = (tenant as any)?.resources_count ?? (tenant as any)?.resourcesCount;
            const resourceCount = Array.isArray((tenant as any)?.resources)
              ? (tenant as any).resources.length
              : typeof resourceCountRaw === "number"
              ? resourceCountRaw
              : 0;
            if (resourceCount > 0) items.push({ key: "resources", label: `${resourceCount} resources` });

            // Only show if memberships are enabled / present.
            const planCount = Array.isArray(membershipPlans) ? membershipPlans.length : 0;
            if (planCount > 0) items.push({ key: "memberships", label: `${planCount} membership plans` });

            // Small trust signal if tenant has working hours configured.
            const wh = (tenant as any)?.working_hours || (tenant as any)?.workingHours;
            const hasWorkingHours = !!wh && (Array.isArray(wh) ? wh.length > 0 : true);
            if (hasWorkingHours) items.push({ key: "live", label: "Live availability" });

            return items.slice(0, 5);
          })();

          const servicesPreview = Array.isArray(services) ? services.slice(0, 6) : [];
          const membershipPlansPreview = Array.isArray(membershipPlans) ? membershipPlans.slice(0, 3) : [];

          return (
            <>
              <div
                style={
                  isPremium
                    ? { maxWidth: 860, margin: "0 auto", width: "100%" }
                    : undefined
                }
              >
                <HomeWelcomeCard
                  tenantName={(tenant as any)?.branding?.business_name || (tenant as any)?.slug || null}
                  signedIn={isSignedIn && !sessionExpired}
                  offers={offers}
                  landing={((tenant as any)?.branding?.homeLanding || (tenant as any)?.branding?.home_landing || (tenant as any)?.branding?.home || null) as any}
                  aboutSections={landingAboutSections}
                  signals={homeSignals as any}
                  servicesPreview={servicesPreview as any}
                  membershipPlansPreview={membershipPlansPreview as any}
                  onViewServices={() => handleTabPress("book")}
                  onViewMemberships={() => handleTabPress("memberships")}
                  nextBooking={next}
                  onOpenNextBooking={next ? () => setHomeNextOpen(true) : undefined}
                  kpis={{
                    upcomingCount: (() => {
                      const items = Array.isArray(history) ? history : [];
                      const now = Date.now();
                      return items.filter((h: any) => {
                        const t = new Date(h.start_time || h.startTime || h.when || 0).getTime();
                        return Number.isFinite(t) && t >= now;
                      }).length;
                    })(),
                    capacityLabel: (() => {
                      const r = (tenant as any)?.resources;
                      const count = Array.isArray(r) ? r.length : (tenant as any)?.resources_count;
                      const n = typeof count === "number" ? count : null;
                      return n ? `${n} resources` : null;
                    })(),
                    membershipsLabel: (() => {
                      const n = Array.isArray(membershipPlans) ? membershipPlans.length : null;
                      return typeof n === "number" ? `${n} plans` : null;
                    })(),
                  }}
                  onBookNow={() => handleTabPress("book")}
                  onViewBookings={() => {
                    if (!isSignedIn || sessionExpired) return handleTabPress("account");
                    return handleTabPress("history");
                  }}
                />
              </div>

              {homeNextOpen && next && (
                <div
                  role="dialog"
                  aria-modal="true"
                  style={{
                    position: "fixed",
                    inset: 0,
                    background: "rgba(0,0,0,0.35)",
                    display: "flex",
                    alignItems: "flex-end",
                    justifyContent: "center",
                    zIndex: 9999,
                    padding: 16,
                  }}
                  onClick={() => setHomeNextOpen(false)}
                >
                  <div
                    style={{
                      width: "min(520px, 100%)",
                      background: "var(--bf-surface, #ffffff)",
                      borderRadius: 18,
                      border: "1px solid var(--bf-border, rgba(15,23,42,0.14))",
                      padding: 14,
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div style={{ fontWeight: "var(--bf-type-title-fw)", marginBottom: 6 }}>Next booking</div>
                    <div style={{ fontSize: "var(--bf-type-body-fs)", opacity: 0.9, marginBottom: 12 }}>
                      {next.when}
                      {next.service ? ` · ${next.service}` : ""}
                    </div>
                    <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
                      <button
                        type="button"
                        onClick={() => {
                          setHomeNextOpen(false);
                          if (!isSignedIn || sessionExpired) return handleTabPress("account");
                          return handleTabPress("history");
                        }}
                        style={{
                          border: "none",
                          borderRadius: 999,
                          padding: "10px 14px",
                          background: "var(--bf-btn-bg, #2563eb)",
                          color: "var(--bf-btn-text, #ffffff)",
                          fontWeight: "var(--bf-type-heading-fw)",
                          cursor: "pointer",
                        }}
                      >
                        View in My bookings
                      </button>
                      <button
                        type="button"
                        onClick={() => setHomeNextOpen(false)}
                        style={{
                          border: "1px solid var(--bf-border, rgba(15,23,42,0.14))",
                          borderRadius: 999,
                          padding: "10px 14px",
                          background: "transparent",
                          fontWeight: "var(--bf-type-heading-fw)",
                          cursor: "pointer",
                        }}
                      >
                        Close
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </>
          );
        })()}

        {/* MEMBERSHIPS TAB */}
        {activeTab === "memberships" && (
          <div
            style={
              isPremium
                ? { maxWidth: 860, margin: "0 auto", width: "100%" }
                : undefined
            }
          >
            <MembershipsTab
              activeTab={activeTab}
              isPremium={isPremium}
              signedIn={isSignedIn && !sessionExpired}
              membershipLabel={(tenant as any)?.labels?.membership_label || "Membership"}
              membershipPlans={membershipPlans as any}
              loadingPlans={loadingPlans}
              plansError={plansError}
              customerMemberships={customerMemberships as any}
              loadingMemberships={loadingMemberships}
              membershipsError={membershipsError}
              subscribingPlanId={subscribingPlanId}
              onSubscribeToPlan={(plan: any) => subscribeToPlan(plan.id)}
              ledgerOpenFor={ledgerOpenFor as any}
              onOpenLedger={(m) => void openLedger(m as any)}
            />
          </div>
        )}

        {/* HISTORY TAB */}
        {activeTab === "history" && isSignedIn && !sessionExpired && customer && (
          <div
            style={
              isPremium
                ? { maxWidth: 860, margin: "0 auto", width: "100%" }
                : undefined
            }
          >
            <BookingHistory
              customer={customer as any}
              isPremium={isPremium}
              history={history}
              loadingHistory={loadingHistory}
              historyError={historyError}
              allowCustomerEdits={allowCustomerEdits}
              onEdit={(b) => setEditingBooking(b)}
            />
          </div>
        )}

        {activeTab === "history" && (!isSignedIn || sessionExpired || !customer) && (
          <p style={{ marginTop: 8, fontSize: "var(--bf-type-caption-fs)", color: TEXT_MUTED }}>
            Please sign in to view your booking history.
          </p>
        )}

        {/* ACCOUNT TAB (keep inside the scroll container so spacing matches other tabs) */}
        {activeTab === "account" && (
          <div
            style={
              isPremium ? { maxWidth: 860, margin: "0 auto", width: "100%" } : undefined
            }
          >
            <AccountTab
              activeTab={activeTab}
              isPremium={isPremium}
              slug={slug}
              customer={customer as any}
                            hideMemberships={true}
              authName={authName}
              setAuthName={setAuthName}
              authPhone={authPhone}
              setAuthPhone={setAuthPhone}
              authEmail={authEmail}
              setAuthEmail={setAuthEmail}
              authSubmitting={authSubmitting}
              authError={authError}
              setAuthError={setAuthError}
              onSaveProfile={handleCustomerAuthSubmitSafe}
              onLogout={handleLogoutCustomerSafe}
              membershipPlans={membershipPlans}
              loadingPlans={loadingPlans}
              plansError={plansError}
              customerMemberships={customerMemberships}
              loadingMemberships={loadingMemberships}
              membershipsError={membershipsError}
              subscribingPlanId={subscribingPlanId}
              onSubscribeToPlan={subscribeToPlan}
              ledgerOpenFor={ledgerOpenFor as any}
              setLedgerOpenFor={setLedgerOpenFor as any}
              ledgerItems={ledgerItems as any}
              loadingLedger={loadingLedger}
              ledgerError={ledgerError}
              onOpenLedger={(m) => void openLedger(m)}
              memberSinceLabel={memberSinceLabel}
            />
          </div>
        )}

        </div>

    </div>
  );

  const overlays = (
    <>
        {/* Phase D: Phone onboarding modal */}
        {phoneOnboardingOpen && isSignedIn && !sessionExpired && customer && !isProfileComplete(customer) && (
          <ModalOverlay
            onClose={() => {
              setPhoneOnboardingOpen(false);
              setPhoneOnboardingDismissed(true);
            }}
          >
            <div
              style={{
                background: CARD_BG,
                borderRadius: 16,
                border: `1px solid ${BORDER_SUBTLE}`,
                boxShadow: "0 18px 40px rgba(15,23,42,0.35)",
                padding: 16,
                maxWidth: 520,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                <div>
                  <div style={{ fontSize: "var(--bf-type-heading-fs)", fontWeight: "var(--bf-type-title-fw)", color: TEXT_MAIN }}>Finish setup</div>
                  <div style={{ fontSize: "var(--bf-type-caption-fs)", color: TEXT_MUTED, marginTop: 2 }}>
                    Add your phone number once — it will stay saved for next time.
                  </div>
                </div>
              </div>

              <form
                onSubmit={(e) => handleCustomerAuthSubmitSafe(e)}
                style={{ marginTop: 14, display: "grid", gap: 10 }}
              >
                <label style={{ display: "grid", gap: 6 }}>
                  <span style={{ fontSize: "var(--bf-type-caption-fs)", fontWeight: "var(--bf-type-heading-fw)", color: TEXT_MUTED }}>Phone number</span>
                  <input
                    type="tel"
                    value={authPhone}
                    onChange={(e) => {
                      setAuthPhone(e.target.value);
                      setAuthError(null);
                    }}
                    placeholder="e.g. +962 7x xxx xxxx"
                    style={{
                      padding: "12px 12px",
                      borderRadius: 12,
                      border: `1px solid ${BORDER_SUBTLE}`,
                      background: "var(--bf-surface, #ffffff)",
                      fontSize: "var(--bf-type-heading-fs)",
                      color: TEXT_MAIN,
                    }}
                    autoFocus
                  />
                </label>

                {authError ? (
                  <div style={{ fontSize: "var(--bf-type-caption-fs)", fontWeight: "var(--bf-type-heading-fw)", color: "#b91c1c" }}>{authError}</div>
                ) : null}

                <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    onClick={() => {
                      setPhoneOnboardingOpen(false);
                      setPhoneOnboardingDismissed(true);
                    }}
                    style={{
                      padding: "10px 12px",
                      borderRadius: 12,
                      border: `1px solid ${BORDER_SUBTLE}`,
                      background: "var(--bf-surface, #ffffff)",
                      color: TEXT_MAIN,
                      fontWeight: "var(--bf-type-heading-fw)",
                      cursor: "pointer",
                    }}
                  >
                    Not now
                  </button>

                  <button
                    type="submit"
                    disabled={authSubmitting}
                    style={{
                      padding: "10px 14px",
                      borderRadius: 12,
                      border: "none",
                      background: "var(--bf-primary, #111827)",
                      color: "var(--bf-primary-contrast, #ffffff)",
                      fontWeight: "var(--bf-type-title-fw)",
                      cursor: authSubmitting ? "not-allowed" : "pointer",
                      opacity: authSubmitting ? 0.7 : 1,
                    }}
                  >
                    {authSubmitting ? "Saving..." : "Save"}
                  </button>
                </div>
              </form>
            </div>
          </ModalOverlay>
        )}

        
{/* Phase G: Membership resolution modal (Smart Top-Up / Renew) */}
{membershipResolutionOpen && membershipResolution && (
  <ModalOverlay
    onClose={() => {
      if (resolutionBusy) return;
      setMembershipResolutionOpen(false);
      setMembershipResolution(null);
      setPendingBookingInput(null);
    }}
    closeOnBackdrop={false}
  >
    <div
      style={{
        background: CARD_BG,
        borderRadius: 16,
        border: `1px solid ${BORDER_SUBTLE}`,
        boxShadow: "0 18px 40px rgba(15,23,42,0.35)",
        padding: 16,
        maxWidth: 560,
        margin: "0 auto",
      }}
    >
      <h3 style={{ margin: 0, fontSize: "var(--bf-type-title-fs)", fontWeight: "var(--bf-type-title-fw)", color: TEXT_MAIN }}>
        Not enough membership balance
      </h3>

      <p style={{ marginTop: 8, fontSize: "var(--bf-type-body-fs)", color: TEXT_MUTED, lineHeight: 1.5 }}>
        Choose how you want to continue. Your selected time is still available right now, but it may change if you wait too long.
      </p>

      {/* Option 1: Smart Top-Up */}
      {membershipResolution?.topUp?.enabled && membershipResolution?.topUp?.allowSelfServe && membershipResolution?.membershipId ? (
        <div
          style={{
            marginTop: 12,
            padding: 12,
            borderRadius: 14,
            border: `1px solid ${BORDER_SUBTLE}`,
            background: "var(--bf-surface, rgba(255,255,255,0.9))",
          }}
        >
          <div style={{ fontWeight: "var(--bf-type-heading-fw)", fontSize: "var(--bf-type-heading-fs)", color: TEXT_MAIN }}>Smart Top-Up</div>
          <div style={{ marginTop: 4, fontSize: "var(--bf-type-body-fs)", color: TEXT_MUTED }}>
            Add <strong>{formatHoursFromMinutes(Number(membershipResolution?.topUp?.minutesNeeded || 0))}</strong>
            {membershipResolution?.topUp?.price != null ? (
              <> • <strong>{membershipResolution.topUp.price} {membershipResolution.topUp.currency || ""}</strong></>
            ) : null}
          </div>

          <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              disabled={resolutionBusy}
              onClick={async () => {
                if (!pendingBookingInput) return;
                const membershipId = Number(membershipResolution?.membershipId);
                const minutesToAdd = Number(membershipResolution?.topUp?.minutesNeeded || 0);
                if (!membershipId || minutesToAdd <= 0) return;

                try {
                  setResolutionBusy(true);

                  // 1) Apply top-up (ledger credit)
                  const r = await fetch(
                    `${BACKEND_URL}/customer-memberships/${membershipId}/top-up?tenantSlug=${encodeURIComponent(slug)}`,
                    {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${authToken}`,
                      },
                      body: JSON.stringify({ minutesToAdd }),
                    }
                  );

                  const j = await r.json().catch(() => ({}));
                  if (!r.ok) throw new Error(j?.message || j?.error || `Top-up failed (${r.status})`);

                  // 2) Retry booking (membership checkbox stays on)
                  await createBooking(pendingBookingInput);

                  setMembershipResolutionOpen(false);
                  setMembershipResolution(null);
                  setPendingBookingInput(null);
                } catch (e: any) {
                  setSubmitError(e?.message || "Top-up failed.");
                } finally {
                  setResolutionBusy(false);
                }
              }}
              style={{
                padding: "10px 14px",
                borderRadius: 999,
                border: "none",
                background: "var(--bf-primary, #22c55e)",
                color: "var(--bf-primary-contrast, #ffffff)",
                cursor: resolutionBusy ? "not-allowed" : "pointer",
                fontSize: "var(--bf-type-body-fs)",
                fontWeight: "var(--bf-type-heading-fw)",
                opacity: resolutionBusy ? 0.7 : 1,
              }}
            >
              {resolutionBusy ? "Processing..." : "Top up & book"}
            </button>
          </div>
        </div>
      ) : null}

      {/* Option 2: Renew / Upgrade */}
      {membershipResolution?.renewUpgrade?.enabled ? (
        <div style={{ marginTop: 12 }}>
          <button
            type="button"
            disabled={resolutionBusy}
            onClick={() => {
              setMembershipResolutionOpen(false);
              setMembershipResolution(null);
              setPendingBookingInput(null);
              setActiveTab("memberships");
            }}
            style={{
              width: "100%",
              padding: "10px 14px",
              borderRadius: 14,
              border: `1px solid ${BORDER_SUBTLE}`,
              background: "transparent",
              color: TEXT_MAIN,
              cursor: resolutionBusy ? "not-allowed" : "pointer",
              fontSize: "var(--bf-type-body-fs)",
              fontWeight: "var(--bf-type-heading-fw)",
            }}
          >
            View membership plans
          </button>
        </div>
      ) : null}

      {/* Option 3: Pay regular (book without membership) */}
      <div style={{ marginTop: 10 }}>
        <button
          type="button"
          disabled={resolutionBusy}
          onClick={async () => {
            if (!pendingBookingInput) return;
            try {
              setResolutionBusy(true);
              setUseMembershipCredits(false);

              const retry: CreateBookingInput = {
                ...pendingBookingInput,
                autoConsumeMembership: false,
                requireMembership: false,
                customerMembershipId: null,
              };

              await createBooking(retry);
              setMembershipResolutionOpen(false);
              setMembershipResolution(null);
              setPendingBookingInput(null);
            } catch (e: any) {
              setSubmitError(e?.message || "Booking failed.");
            } finally {
              setResolutionBusy(false);
            }
          }}
          style={{
            width: "100%",
            padding: "10px 14px",
            borderRadius: 14,
            border: "none",
            background: "var(--bf-surface, #ffffff)",
            color: TEXT_MAIN,
            cursor: resolutionBusy ? "not-allowed" : "pointer",
            fontSize: "var(--bf-type-body-fs)",
            fontWeight: "var(--bf-type-heading-fw)",
          }}
        >
          Book without membership (pay regular rate)
        </button>
      </div>

      <div style={{ marginTop: 12, fontSize: "var(--bf-type-caption-fs)", color: TEXT_MUTED }}>
        Tip: If you want this to be enforced for everyone, enable <strong>Strict</strong> mode in the tenant settings.
      </div>
    </div>
  </ModalOverlay>
)}

        {/* EDIT BOOKING MODAL */}
        {editingBooking && (
          <ModalOverlay onClose={() => setEditingBooking(null)}>
            <BookingDetailsCard
              title="Booking Details"
              booking={editingBooking}
              onClose={() => setEditingBooking(null)}
              primaryButtons={
                <>
<button
                    type="button"
                    onClick={() => handleCancelBooking(editingBooking.id)}
                    style={{
                      padding: "8px 14px",
                      borderRadius: 999,
                      border: "none",
                      background: "#ef4444",
                      color: "#fff",
                      cursor: "pointer",
                      fontSize: "var(--bf-type-body-fs)",
                      fontWeight: "var(--bf-type-heading-fw)",
                    }}
                  >
                    Cancel booking
                  </button>
                </>
              }            />
          </ModalOverlay>
        )}

        {/* LEDGER MODAL */}
        {ledgerOpenFor && (
          <ModalOverlay onClose={closeLedger} closeOnBackdrop={false}>
            <div
              style={{
                // Match the same "glass card" surface used by other modals.
                // (Avoid non-CSS props like "radius"/"shadow" so TS stays strict.)
                ...createCardStyle(theme, {
                  marginTop: 0,
                  marginBottom: 0,
                  padding: 16,
                }),
                width: "min(920px, calc(100vw - 32px))",
                maxHeight: "min(80vh, 720px)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 10,
                }}
              >
                <div>
                  <div style={{ fontSize: "var(--bf-type-heading-fs)", fontWeight: "var(--bf-type-heading-fw)", color: TEXT_MAIN }}>
                    Usage history
                  </div>
                  <div style={{ marginTop: 4, fontSize: "var(--bf-type-caption-fs)", color: TEXT_MUTED }}>
                    {ledgerOpenFor.plan_name || `Plan #${ledgerOpenFor.plan_id}`}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={closeLedger}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 999,
                    border: `1px solid ${BORDER_SUBTLE}`,
                    background: PAGE_BG,
                    fontSize: "var(--bf-type-caption-fs)",
                    cursor: "pointer",
                    height: 32,
                  }}
                >
                  Close
                </button>
              </div>

              {ledgerError && (
                <div style={{ marginTop: 10, fontSize: "var(--bf-type-caption-fs)", color: "#b91c1c" }}>
                  ⚠ {ledgerError}
                </div>
              )}

              {loadingLedger ? (
                <div style={{ marginTop: 12, fontSize: "var(--bf-type-caption-fs)", color: TEXT_MUTED }}>
                  Loading…
                </div>
              ) : ledgerItems.length === 0 ? (
                <div style={{ marginTop: 12, fontSize: "var(--bf-type-caption-fs)", color: TEXT_MUTED }}>
                  No usage yet.
                </div>
              ) : (
                <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
                  {ledgerItems.map((it) => (
                    <div
                      key={it.id}
                      style={{
                        padding: 10,
                        borderRadius: 12,
                        border: `1px solid ${BORDER_SUBTLE}`,
                        background: "var(--bf-surface)",
                        backdropFilter: "var(--bf-blur)",
                        fontSize: "var(--bf-type-caption-fs)",
                        color: TEXT_MAIN,
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 10,
                      }}
                    >
                      <div style={{ color: TEXT_MUTED }}>
                        {new Date(it.created_at).toLocaleString()}
                        {it.note ? ` • ${it.note}` : ""}
                      </div>
                      <div style={{ fontWeight: "var(--bf-type-heading-fw)" }}>
                        {it.minutes_delta != null
                          ? formatHoursFromMinutes(it.minutes_delta)
                          : ""}
                        {it.uses_delta != null ? `${it.uses_delta} uses` : ""}
                        {it.minutes_delta == null && it.uses_delta == null
                          ? it.type
                          : ""}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </ModalOverlay>
        )}

    </>
  );

  const handleTabPress = (tab: ActiveTab) => {
    // Require sign-in for customer-private views
    const needsAuth = tab === "account" || tab === "history" || tab === "memberships";

    if (needsAuth) {
      if (!isSignedIn || sessionExpired) {
        const returnUrl = `${window.location.origin}/book/${slug}`;
        redirectToCentralGoogleAuth(returnUrl);
        return;
      }
    }

    // If signed in but customer isn't created yet, allow Account but not others
    if ((tab === "history" || tab === "memberships") && !customer) {
      setActiveTab("account");
      return;
    }

    setActiveTab(tab);
  };

  const disabledTabs: ActiveTab[] = (() => {
    const locked: ActiveTab[] = [];
    const needsAuth: ActiveTab[] = ["account", "history", "memberships"];
    if (!isSignedIn || sessionExpired) return needsAuth;
    // Signed in but customer not hydrated yet: keep the user in Account to finish onboarding/profile.
    if (!customer) return ["history", "memberships"];
    return locked;
  })();

  const handleDisabledPress = (tab: ActiveTab) => {
    // If auth is missing/expired: take user to Google sign-in (same as handleTabPress).
    if (!isSignedIn || sessionExpired) {
      const returnUrl = `${window.location.origin}/book/${slug}`;
      redirectToCentralGoogleAuth(returnUrl);
      return;
    }
    // If customer isn't created yet, route to account.
    if ((tab === "history" || tab === "memberships") && !customer) {
      setActiveTab("account");
      return;
    }
  };

  return (
    <ThemeProvider theme={theme}>
      <TenantCssVarsProvider theme={theme} tenant={tenant} bootstrapBranding={bootstrapBranding} themeTokens={themeTokens} brandOverrides={brandOverrides}>
        <Layout
          tenant={tenant}
          hero={hero}
          content={content}
          overlays={overlays}
          navItems={navItems}
          activeTab={activeTab}
          onTabPress={handleTabPress}
          disabledTabs={disabledTabs}
          onDisabledPress={handleDisabledPress}
          isSignedIn={isSignedIn && !sessionExpired}
          signedInEmail={session?.user?.email || null}
          onLogin={() => {
            const returnUrl = `${window.location.origin}/book/${slug}`;
            redirectToCentralGoogleAuth(returnUrl);
          }}
          onLogout={handleLogoutCustomerSafe}
        />
      </TenantCssVarsProvider>
    </ThemeProvider>
  );
}