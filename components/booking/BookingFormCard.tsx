"use client";

import React, { FormEvent, useCallback, useEffect, useRef } from "react";
import { useTheme } from "@/lib/theme/ThemeContext";
import { createCardStyle } from "@/lib/theme/styles";
import PillButton from "@/components/booking/PillButton";
import type { Service, Staff, Resource, TimeSlot } from "@/types/booking";
import ImageSelect from "@/components/booking/ui/ImageSelect";
import BookingCardHeader from "@/components/booking/ui/BookingCardHeader";

// components/booking/BookingFormCard.tsx


type Props = {
  // flags
  customerExists: boolean;
  loading: boolean;
  error: string | null;
  showServiceMeta?: boolean;
  staffLabelSingular?: string;
  resourceLabelSingular?: string;
  activeTab: "book" | "history" | "account" | "home";
  view: "booking" | "confirmation";

  // state
  selectedDate: string;
  serviceId: number | "";
  staffId: number | "";
  resourceId: number | "";
  selectedTimes: string[];
  submitError: string | null;
  setSelectedTimes: React.Dispatch<React.SetStateAction<string[]>>;
  setSubmitError: React.Dispatch<React.SetStateAction<string | null>>;
  submitting: boolean;

  // membership (Phase 2)
  canUseMembership?: boolean;
  /**
   * Owner/slug manual booking wants this toggle always visible as a staff reminder.
   * Public booking keeps the existing behavior (toggle only appears when eligible).
   */
  forceShowMembershipToggle?: boolean;
  membershipToggleDisabled?: boolean;
  membershipToggleHint?: string;
  useMembershipCredits?: boolean;
  setUseMembershipCredits?: (v: boolean) => void;
  membershipLabel?: string;

  // derived
  services: Service[];
  staff: Staff[];
  resources: Resource[];
  selectedService?: Service | undefined;
  requiresStaff: boolean;
  requiresResource: boolean;

  // availability
  timeSlots: TimeSlot[];
  loadingSlots: boolean;
  availabilityError: string | null;

  // slot rules (service-driven)
  intervalMinutes: number;
  minSlots: number;
  maxSlots: number;
  selectedDurationMinutes: number;

  // handlers
  onSubmit: (e: FormEvent) => void;
  setSelectedDate: (v: string) => void;
  setServiceId: (v: number | "") => void;
  setStaffId: (v: number | "") => void;
  setResourceId: (v: number | "") => void;

  // selection (single source of truth lives in page.tsx)
  onToggleSlot: (time: string) => void;

  // utils
  formatLocalDate: (d: Date) => string;

  // layout
  isPremium?: boolean;
};

export default function BookingFormCard(props: Props) {
  const theme = useTheme();

  const {
    loading,
    error,
    showServiceMeta = true,
    staffLabelSingular = "Staff",
    resourceLabelSingular = "Resource",
    activeTab,
    view,

    selectedDate,
    serviceId,
    staffId,
    resourceId,
    selectedTimes,
    setSelectedTimes,
    submitError,
    setSubmitError,
    submitting,

    canUseMembership = false,
    forceShowMembershipToggle = false,
    membershipToggleDisabled = false,
    membershipToggleHint,
    useMembershipCredits = false,
    setUseMembershipCredits,
    membershipLabel = "Use membership credits",

    services,
    staff,
    resources,
    selectedService,
    requiresStaff,
    requiresResource,

    timeSlots,
    loadingSlots,
    availabilityError,

    intervalMinutes,
    minSlots,
    maxSlots,
    selectedDurationMinutes,

    onSubmit,
    setSelectedDate,
    setServiceId,
    setStaffId,
    setResourceId,

    onToggleSlot,
    formatLocalDate,

    isPremium = false,
  } = props;

  // Defensive defaults: if minSlots/maxSlots are missing (undefined/NaN), the confirm button can get stuck disabled.
  // Treat missing values as 1 slot minimum, and cap max at a sane default.
  const minSlotsSafe = Number.isFinite(minSlots as any) && (minSlots as any) > 0 ? (minSlots as any) : 1;
  const maxSlotsSafe = Number.isFinite(maxSlots as any) && (maxSlots as any) > 0 ? (maxSlots as any) : 1;

  // Never allow selecting a date before today (customer should not be able to book in the past).
  // We enforce this in the UI with `min`, and also clamp any stale/invalid state.
  const todayStr = formatLocalDate(new Date());

  // Track previous "driver" fields so we can reset dependent state when they change.
  // This prevents "ghost" selected slots carrying across date/service/staff/resource changes.
  const prevDateRef = useRef<string | null>(null);
  const prevServiceRef = useRef<number | "" | null>(null);
  const prevStaffRef = useRef<number | "" | null>(null);
  const prevResourceRef = useRef<number | "" | null>(null);

  // If the booking date changes, reset the booking flow selections.
  // (Users expect a fresh selection because availability and slots are date-scoped.)
  useEffect(() => {
    if (!selectedDate) return;
    const prev = prevDateRef.current;
    prevDateRef.current = selectedDate;
    if (prev === null) return; // first render
    if (prev !== selectedDate) {
      setSelectedTimes([]);
      setSubmitError(null);
      setServiceId("");
      setStaffId("");
      setResourceId("");
    }
  }, [selectedDate, setSelectedTimes, setSubmitError, setServiceId, setStaffId, setResourceId]);

  // If the service changes, clear downstream selections.
  useEffect(() => {
    const prev = prevServiceRef.current;
    prevServiceRef.current = serviceId;
    if (prev === null) return;
    if (prev !== serviceId) {
      setSelectedTimes([]);
      setSubmitError(null);
      setStaffId("");
      setResourceId("");
    }
  }, [serviceId, setSelectedTimes, setSubmitError, setStaffId, setResourceId]);

  // If staff/resource changes, clear selected time slots to avoid mixing contexts.
  useEffect(() => {
    const prev = prevStaffRef.current;
    prevStaffRef.current = staffId;
    if (prev === null) return;
    if (prev !== staffId) {
      setSelectedTimes([]);
      setSubmitError(null);
    }
  }, [staffId, setSelectedTimes, setSubmitError]);

  useEffect(() => {
    const prev = prevResourceRef.current;
    prevResourceRef.current = resourceId;
    if (prev === null) return;
    if (prev !== resourceId) {
      setSelectedTimes([]);
      setSubmitError(null);
    }
  }, [resourceId, setSelectedTimes, setSubmitError]);

  useEffect(() => {
    // Only safe for YYYY-MM-DD. Native <input type="date"> uses this format as its value.
    // IMPORTANT: don't auto-fill when empty; we want the user to explicitly pick a date.
    if (!selectedDate || !selectedDate.includes("-")) return;
    if (selectedDate < todayStr) {
      setSelectedTimes([]);
      setSubmitError(null);
      setSelectedDate(todayStr);
    }
  }, [selectedDate, todayStr, setSelectedDate, setSelectedTimes, setSubmitError]);

  // If the user previously triggered a gating error (e.g. tried selecting service before date),
  // clear it once the prerequisite is satisfied.
  useEffect(() => {
    if (!selectedDate) return;
    if (
      submitError === "Please select a date first." ||
      submitError === "Please select a service first."
    ) {
      setSubmitError(null);
    }
  }, [selectedDate, submitError, setSubmitError]);

  // Theme tokens (single source of truth)
  const BORDER_SUBTLE = theme.card.borderSubtle;
  const CARD_BG = theme.card.bg;
  const PAGE_BG = theme.page.bg;
  const TEXT_MAIN = theme.text.main;
  const TEXT_MUTED = theme.text.muted;
  const TEXT_SOFT = theme.text.soft;
  const BRAND_PRIMARY = theme.brand.primary;

  // ------------------------------------------------------------
  // Booking flow gating (industry standard):
  // Date -> Service -> (Staff/Resource) -> Time
  // Parent changes reset children (handled by effects above).
  // We also gate UI interactions so Premium + Classic can never diverge.
  // ------------------------------------------------------------
  const canSelectService = !!selectedDate;
  const canSelectStaff = canSelectService && serviceId !== "";
  const canSelectResource = canSelectService && serviceId !== "";

  // Allow layouts (like Premium) to override form control chrome using CSS vars.
  // If vars are not set, it falls back to the current theme tokens.
  const CONTROL_BG = `var(--bf-control-bg, ${CARD_BG})`;
  const CONTROL_BORDER = `1px solid var(--bf-control-border, ${BORDER_SUBTLE})`;
  const CONTROL_RADIUS = `var(--bf-control-radius, 10px)`;
  const CONTROL_HEIGHT = `var(--bf-control-height, 44px)`;
  const CONTROL_PAD_X = `var(--bf-control-pad-x, 12px)`;
  const CONTROL_FONT = `var(--bf-control-font, 13px)`;
  const LABEL_FONT = `var(--bf-label-font, 13px)`;
  const LABEL_WEIGHT = `var(--bf-label-weight, 500)`;
  const VALUE_WEIGHT = `var(--bf-value-weight, 500)`;
  const FIELD_GAP = "var(--bf-field-gap, 12px)";
  const LABEL_GAP = "var(--bf-label-gap, 8px)";

  // Date control should visually match other form controls (like Select Service)
  // across both light and dark tenant themes.
  // Use the same control chrome variables as the other selectors.
  const DATE_CONTROL_BG = CONTROL_BG;
  const DATE_CONTROL_BORDER = CONTROL_BORDER;

  // Disable time slots that are already in the past.
  // Our date input has historically been formatted as either:
  //  - YYYY-MM-DD (native date input)
  //  - MM/DD/YYYY (custom formatted display)
  // We support both to avoid regressions.
  const isPastSlot = useCallback(
    (slotTime: string) => {
      if (!selectedDate) return false;

      const parseSelectedDate = (
        value: string
      ): { y: number; m: number; d: number } | null => {
        // YYYY-MM-DD
        if (value.includes("-")) {
          const parts = value.split("-").map((p) => Number(p));
          if (parts.length !== 3 || parts.some((n) => Number.isNaN(n)))
            return null;
          return { y: parts[0], m: parts[1], d: parts[2] };
        }

        // MM/DD/YYYY or DD/MM/YYYY
        if (value.includes("/")) {
          const raw = value.split("/").map((p) => Number(p));
          if (raw.length !== 3 || raw.some((n) => Number.isNaN(n)))
            return null;
          const [a, b, y] = raw;
          // If first part > 12, assume DD/MM/YYYY, otherwise MM/DD/YYYY.
          const m = a > 12 ? b : a;
          const d = a > 12 ? a : b;
          return { y, m, d };
        }

        return null;
      };

      const dateParts = parseSelectedDate(selectedDate);
      if (!dateParts) return false;
      const { y, m, d } = dateParts;

      const [hhStr, mmStr] = slotTime.split(":");
      const hh = Number(hhStr);
      const mm = Number(mmStr);
      if (Number.isNaN(hh) || Number.isNaN(mm)) return false;

      const slotDateTime = new Date(y, m - 1, d, hh, mm, 0, 0);
      const now = new Date();

      // If the entire day is before today, it's past.
      const todayStart = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        0,
        0,
        0,
        0
      );
      const slotDayStart = new Date(y, m - 1, d, 0, 0, 0, 0);
      if (slotDayStart.getTime() < todayStart.getTime()) return true;

      // If it's today, block any slot <= now.
      if (slotDayStart.getTime() === todayStart.getTime()) {
        return slotDateTime.getTime() <= now.getTime();
      }

      return false;
    },
    [selectedDate]
  );

  // Premium uses a rich, image-capable select (native <select> cannot render images).
  // We also allow forcing it via CSS var.
  const useRichSelect =
    isPremium ||
    (typeof window !== "undefined" &&
      getComputedStyle(document.documentElement)
        .getPropertyValue("--bf-rich-select")
        .trim() === "1");

  function bestImageUrl(o: any): string | null {
    return o?.image_url || o?.photo_url || o?.avatar_url || null;
  }

  // UX: allow the CTA to become active as soon as a valid selection is made.
  // If the visitor isn't signed in, the submit handler will guide them to auth.
  const canSubmit =
    !!selectedDate &&
    !!serviceId &&
    Array.isArray(selectedTimes) &&
    selectedTimes.length >= minSlotsSafe &&
    !submitting;

  // Only show in Book tab, booking view, with data
  const shouldShow =
    !loading &&
    !error &&
    services.length > 0 &&
    view === "booking" &&
    activeTab === "book";

  // Make the entire date field clickable (not only the small icon).
  const dateInputRef = useRef<HTMLInputElement | null>(null);

  // Step-by-step auto-scroll refs ("real app" feel on mobile)
  const serviceFieldRef = useRef<HTMLDivElement | null>(null);
  const staffFieldRef = useRef<HTMLDivElement | null>(null);
  const resourceFieldRef = useRef<HTMLDivElement | null>(null);
  const slotsRef = useRef<HTMLDivElement | null>(null);

  // "Real app" behavior: after the final dropdown selection, gently scroll to the
  // confirm button with a little extra space so it isn't glued to the bottom.
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);

  // When the final dropdown is selected, more UI often renders **after** the click
  // (resource preview image + fetched time slots). If we scroll immediately, we can
  // land too high (half image visible). We mark a pending scroll and complete it
  // after layout has settled (slots loaded / error resolved).
  const pendingFinalScrollRef = useRef(false);

  const scrollByY = useCallback((delta: number) => {
    if (typeof window === "undefined") return;
    if (!delta || Number.isNaN(delta)) return;
    const se = document.scrollingElement as HTMLElement | null;
    if (se && se !== document.documentElement) {
      se.scrollBy({ top: delta, behavior: "smooth" });
      return;
    }
    window.scrollBy({ top: delta, behavior: "smooth" });
  }, []);

  const scrollElIntoView = useCallback(
    (el: HTMLElement | null, bottomPad = 18) => {
      if (typeof window === "undefined") return;
      if (!el) return;

      requestAnimationFrame(() => {
        const rect = el.getBoundingClientRect();
        const viewportBottom = window.innerHeight;
        const targetBottom = viewportBottom - bottomPad;

        // If element bottom is too low, scroll down just enough.
        const deltaDown = rect.bottom - targetBottom;
        if (deltaDown > 0) {
          scrollByY(deltaDown);
          return;
        }

        // If element top is above the viewport, scroll up slightly.
        const deltaUp = rect.top - 12;
        if (deltaUp < 0) scrollByY(deltaUp);
      });
    },
    [scrollByY]
  );

  const scrollConfirmIntoView = useCallback((bottomPad = 36) => {
    if (typeof window === "undefined") return;

    requestAnimationFrame(() => {
      const btn = confirmBtnRef.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      const viewportBottom = window.innerHeight;
      const targetBottom = viewportBottom - bottomPad;

      // If the button is too low, scroll down just enough.
      const deltaDown = rect.bottom - targetBottom;
      if (deltaDown > 0) {
        window.scrollBy({ top: deltaDown, behavior: "smooth" });
        return;
      }

      // If the button is above the viewport, scroll it into view.
      const deltaUp = rect.top - 12;
      if (deltaUp < 0) window.scrollBy({ top: deltaUp, behavior: "smooth" });
    });
  }, []);

  const openDatePicker = useCallback(() => {
    const el = dateInputRef.current;
    if (!el) return;

    type PickerInput = HTMLInputElement & { showPicker?: () => void };
    const pickerEl = el as PickerInput;

    try {
      el.focus();
      if (typeof pickerEl.showPicker === "function") return pickerEl.showPicker();
      el.click();
    } catch {
      // ignore
    }
  }, []);

  const handleStaffSelect = useCallback(
    (v: number | "") => {
      // Guard: staff selection requires date + service first.
      if (!selectedDate || serviceId === "") {
        setSubmitError(!selectedDate ? "Please select a date first." : "Please select a service first.");
        return;
      }
      setStaffId(v);

      // If resource is required, staff is not final — scroll to resource selector.
      if (requiresResource && v !== "") {
        scrollElIntoView(resourceFieldRef.current, 220);
      }

      // If this service does not require a resource, staff is the final dropdown.
      if (!requiresResource && v !== "") {
        pendingFinalScrollRef.current = true;
        // Start an initial gentle scroll, then we will "finish" after slots/layout render.
        scrollConfirmIntoView();
      }
    },
    [requiresResource, scrollConfirmIntoView, scrollElIntoView, selectedDate, serviceId, setStaffId, setSubmitError]
  );

  const handleResourceSelect = useCallback(
    (v: number | "") => {
      // Guard: resource selection requires date + service first.
      if (!selectedDate || serviceId === "") {
        setSubmitError(!selectedDate ? "Please select a date first." : "Please select a service first.");
        return;
      }
      setResourceId(v);

      // After selecting the final dropdown (resource), scroll to the time slots area.
      if (v !== "") {
        // Do an early gentle nudge towards slots, then the existing confirm-scroll logic will finish.
        scrollElIntoView(slotsRef.current, 260);
      }

      // Resource is always the final dropdown when required.
      if (v !== "") {
        pendingFinalScrollRef.current = true;
        // Start an initial gentle scroll, then we will "finish" after slots/layout render.
        scrollConfirmIntoView();
      }
    },
    [scrollConfirmIntoView, scrollElIntoView, selectedDate, serviceId, setResourceId, setSubmitError]
  );

  const handleServiceSelect = useCallback(
    (v: number | "") => {
      // Guard: service requires a date first.
      if (!selectedDate) {
        setSubmitError("Please select a date first.");
        return;
      }
      setServiceId(v);
      if (v === "") return;

      // Determine next field based on selected service requirements.
      const svc = services.find((s) => s.id === v);
      const nextRequiresStaff = !!svc?.requires_staff;
      const nextRequiresResource = !!svc?.requires_resource;

      // Give React a tick to render dependent fields before measuring.
      window.setTimeout(() => {
        if (nextRequiresStaff) {
          scrollElIntoView(staffFieldRef.current, 220);
          return;
        }
        if (nextRequiresResource) {
          scrollElIntoView(resourceFieldRef.current, 220);
          return;
        }
        // If neither is required, jump straight to slots.
        scrollElIntoView(slotsRef.current, 260);
      }, 40);
    },
    [scrollElIntoView, services, selectedDate, setServiceId, setSubmitError]
  );

  // Finish the scroll after the dynamic content has rendered.
  // Triggers when:
  // - final dropdown selected (pendingFinalScrollRef)
  // - and either timeSlots are loaded OR we have an availabilityError
  useEffect(() => {
    if (!pendingFinalScrollRef.current) return;

    // Only complete once slots have finished loading (or errored) for the latest selection.
    if (loadingSlots) return;

    // If we have neither slots nor an error yet, do nothing.
    if ((timeSlots?.length ?? 0) === 0 && !availabilityError) return;

    // Give React one more paint + allow images to commit height before measuring.
    const t = window.setTimeout(() => {
      // Use a slightly larger bottom pad so the last slot/button isn't glued to the bottom.
      scrollConfirmIntoView(72);
      pendingFinalScrollRef.current = false;
    }, 90);

    return () => window.clearTimeout(t);
  }, [availabilityError, loadingSlots, scrollConfirmIntoView, timeSlots]);

  if (!shouldShow) return null;

  const selectedResource =
    resources.find((r) => r.id === resourceId) || null;
  const selectedResourceImage = selectedResource
    ? bestImageUrl(selectedResource)
    : null;

  return (
    <section
      style={
        isPremium
          ? createCardStyle(theme, {
              maxWidth: 860,
              marginLeft: "auto",
              marginRight: "auto",
              overflow: "visible",
              padding: 0,
            })
          : createCardStyle(theme)
      }
    >
      {isPremium && (
        <BookingCardHeader
          kicker="START HERE"
          title="Choose Service / Staff / Resource / Time"
        />
      )}

      <form
        onSubmit={onSubmit}
        style={isPremium ? { padding: "18px" } : undefined}
      >
      {isPremium ? (
        <style jsx global>{`
          /* Premium: normalize native date input to match our dropdown styling */
          input[data-bf-date="1"]::-webkit-calendar-picker-indicator {
            opacity: 0;
            display: block;
            position: absolute;
            right: 0;
            top: 0;
            width: 100%;
            height: 100%;
            cursor: pointer;
          }
          input[data-bf-date="1"]::-webkit-inner-spin-button,
          input[data-bf-date="1"]::-webkit-clear-button {
            display: none;
          }
          input[data-bf-date="1"]::-webkit-datetime-edit {
            padding: 0;
          }
        `}</style>
      ) : null}
        {/* Date */}
        <div style={{ marginBottom: FIELD_GAP }}>
          <label
            style={{
              display: "block",
              fontSize: LABEL_FONT,
              fontWeight: LABEL_WEIGHT as any,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: TEXT_MUTED,
              marginBottom: LABEL_GAP,
            }}
          >
            Select date
          </label>

        <div style={{ position: "relative" }}>
          <input
            ref={dateInputRef}
            type="date"
            data-bf-date="1"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            min={todayStr}
            style={{
              width: "100%",
              height: CONTROL_HEIGHT,
              padding: `0 calc(${CONTROL_PAD_X} + 22px) 0 ${CONTROL_PAD_X}`, // room for chevron
              borderRadius: CONTROL_RADIUS,
              border: DATE_CONTROL_BORDER,
              background: DATE_CONTROL_BG,
              boxShadow: "none",
              WebkitBoxShadow: "none" as any,
              // When no date is selected, many browsers show a native "mm/dd/yyyy" placeholder.
              // We hide it so ONLY our "Select date" placeholder overlay is visible.
              color: selectedDate ? TEXT_MAIN : "transparent",
              WebkitTextFillColor: (selectedDate ? TEXT_MAIN : "transparent") as any,
              caretColor: selectedDate ? TEXT_MAIN : "transparent",
              fontSize: CONTROL_FONT,
              fontWeight: VALUE_WEIGHT as any,
              outline: "none",
              cursor: "pointer",
              appearance: "none" as any,
              WebkitAppearance: "none" as any,
              position: "relative",
              zIndex: 1,
            }}
            onClick={openDatePicker}
          />

          {/* Placeholder overlay: must include border/background so the field always looks consistent. */}
          {!selectedDate && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                padding: `0 calc(${CONTROL_PAD_X} + 22px) 0 ${CONTROL_PAD_X}`,
                borderRadius: CONTROL_RADIUS,
                border: DATE_CONTROL_BORDER,
                background: DATE_CONTROL_BG,
              boxShadow: "none",
              WebkitBoxShadow: "none" as any,
                color: TEXT_SOFT,
                fontSize: CONTROL_FONT,
                fontWeight: VALUE_WEIGHT as any,
                pointerEvents: "none",
                zIndex: 2,
              }}
            >
              Select date
            </div>
          )}

          {/* Chevron (same cue as dropdown) */}
          <div
            style={{
              position: "absolute",
              right: CONTROL_PAD_X,
              top: 0,
              height: CONTROL_HEIGHT,
              display: "flex",
              alignItems: "center",
              color: TEXT_SOFT,
              pointerEvents: "none",
              zIndex: 3,
              opacity: 0.9,
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M6 9l6 6 6-6"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>

          {/* Keep the whole field clickable (Safari) */}
          <button
            type="button"
            onClick={openDatePicker}
            aria-label="Open date picker"
            style={{
              position: "absolute",
              inset: 0,
              background: "transparent",
              border: 0,
              padding: 0,
              cursor: "pointer",
              zIndex: 4,
            }}
          />
        </div>
        </div>

        {/* Service */}
        <div ref={serviceFieldRef} style={{ marginBottom: FIELD_GAP }}>
          <label
            style={{
              display: "block",
              fontSize: LABEL_FONT,
              fontWeight: LABEL_WEIGHT as any,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: TEXT_MUTED,
              marginBottom: LABEL_GAP,
            }}
          >
            Select service
          </label>

          {useRichSelect ? (
            <ImageSelect
              value={serviceId}
              placeholder="Select a service"
              disabled={!canSelectService}
              onChange={(val) => handleServiceSelect(val)}
              onOpenChange={(open) => {
                if (open) scrollElIntoView(serviceFieldRef.current, 260);
              }}
              options={services.map((s) => ({
                value: s.id,
                label: s.name,
                imageUrl: bestImageUrl(s) || undefined,
                meta: showServiceMeta
                  ? `${s.duration_minutes ?? ""} minutes${
                      s.requires_staff ? ", Requires staff." : ""
                    }${s.requires_resource ? ", Requires resource." : ""}`
                  : undefined,
              }))}
            />
          ) : (
            <select
              value={serviceId}
              disabled={!canSelectService}
              onChange={(e) =>
                handleServiceSelect(
                  e.target.value ? Number(e.target.value) : ""
                )
              }
              onFocus={() => scrollElIntoView(serviceFieldRef.current, 260)}
              style={{
                width: "100%",
                height: CONTROL_HEIGHT,
                padding: `0 ${CONTROL_PAD_X}`,
                borderRadius: CONTROL_RADIUS,
                border: CONTROL_BORDER,
                background: CONTROL_BG,
                color: TEXT_MAIN,
                fontSize: CONTROL_FONT,
                fontWeight: VALUE_WEIGHT as any,
                outline: "none",
                opacity: !canSelectService ? 0.55 : 1,
                cursor: !canSelectService ? "not-allowed" : "pointer",
              }}
            >
              <option value="">Select a service</option>
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}

          {showServiceMeta && selectedService && (
            <div
              style={{
                marginTop: 8,
                fontSize: 12,
                color: TEXT_SOFT,
                lineHeight: 1.4,
              }}
            >
              {selectedService.duration_minutes ?? ""} minutes.
              {selectedService.requires_staff ? " Requires staff." : ""}{" "}
              {selectedService.requires_resource ? " Requires resource." : ""}
              <div style={{ marginTop: 4 }}>
                Interval: {intervalMinutes} min · Min: {minSlotsSafe} slot(s) · Max:{" "}
                {maxSlots} slot(s)
              </div>
            </div>
          )}
        </div>

        {/* Staff */}
        {requiresStaff && (
          <div ref={staffFieldRef} style={{ marginBottom: FIELD_GAP }}>
            <label
              style={{
                display: "block",
                fontSize: LABEL_FONT,
                fontWeight: LABEL_WEIGHT as any,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color: TEXT_MUTED,
                marginBottom: LABEL_GAP,
              }}
            >
              {`Select a ${staffLabelSingular}`}
            </label>

            {useRichSelect ? (
              <ImageSelect
                value={staffId}
                placeholder={`Select a ${staffLabelSingular}`}
              disabled={!canSelectStaff}
                onChange={(val) => handleStaffSelect(val)}
                onOpenChange={(open) => {
                  if (open) scrollElIntoView(staffFieldRef.current, 260);
                }}
                options={staff.map((s) => ({
                  value: s.id,
                  label: s.name,
                  imageUrl: bestImageUrl(s) || undefined,
                }))}
              />

            ) : (
              <select
                value={staffId}
              disabled={!canSelectStaff}
                onChange={(e) =>
                  handleStaffSelect(
                    e.target.value ? Number(e.target.value) : ""
                  )
                }
                onFocus={() => scrollElIntoView(staffFieldRef.current, 260)}
                style={{
                  width: "100%",
                  height: CONTROL_HEIGHT,
                  padding: `0 ${CONTROL_PAD_X}`,
                  borderRadius: CONTROL_RADIUS,
                  border: CONTROL_BORDER,
                  background: CONTROL_BG,
                  color: TEXT_MAIN,
                  fontSize: CONTROL_FONT,
                  fontWeight: VALUE_WEIGHT as any,
                  outline: "none",
                opacity: !canSelectStaff ? 0.55 : 1,
                cursor: !canSelectStaff ? "not-allowed" : "pointer",
                }}
              >
                <option value="">{`Select a ${staffLabelSingular}`}</option>
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        {/* Resource */}
        {requiresResource && (
          <div ref={resourceFieldRef} style={{ marginBottom: FIELD_GAP }}>
            <label
              style={{
                display: "block",
                fontSize: LABEL_FONT,
                fontWeight: LABEL_WEIGHT as any,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color: TEXT_MUTED,
                marginBottom: LABEL_GAP,
              }}
            >
              {`Select a ${resourceLabelSingular}`}
            </label>

            {useRichSelect ? (
              <ImageSelect
                value={resourceId}
                placeholder={`Select a ${resourceLabelSingular}`}
                disabled={!canSelectResource}
                onChange={(val) => handleResourceSelect(val)}
                onOpenChange={(open) => {
                  if (open) scrollElIntoView(resourceFieldRef.current, 260);
                }}
                options={resources.map((r) => ({
                  value: r.id,
                  label: r.name,
                  imageUrl: bestImageUrl(r) || undefined,
                }))}
              />

            ) : (
              <select
                value={resourceId}
                disabled={!canSelectResource}
                onChange={(e) =>
                  handleResourceSelect(
                    e.target.value ? Number(e.target.value) : ""
                  )
                }
                onFocus={() => scrollElIntoView(resourceFieldRef.current, 260)}
                style={{
                  width: "100%",
                  height: CONTROL_HEIGHT,
                  padding: `0 ${CONTROL_PAD_X}`,
                  borderRadius: CONTROL_RADIUS,
                  border: CONTROL_BORDER,
                  background: CONTROL_BG,
                  color: TEXT_MAIN,
                  fontSize: CONTROL_FONT,
                  fontWeight: VALUE_WEIGHT as any,
                  outline: "none",
                  opacity: !canSelectResource ? 0.55 : 1,
                  cursor: !canSelectResource ? "not-allowed" : "pointer",
                }}
              >
                <option value="">{`Select a ${resourceLabelSingular}`}</option>
                {resources.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        {/* Resource Preview */}
        {selectedResource && (
          <div style={{ marginTop: 10, marginBottom: 12 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 10,
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  letterSpacing: "0.14em",
                  textTransform: "uppercase",
                  color: TEXT_MUTED,
                }}
              >
                {selectedResource.name}
              </div>

              <span
                style={{
                  fontSize: 12,
                  padding: "6px 10px",
                  borderRadius: "var(--bf-radius-pill, 999px)",
                  border: `1px solid ${BORDER_SUBTLE}`,
                  color: TEXT_SOFT,
                  background: "var(--bf-preview-pill-bg, rgba(255,255,255,0.03))",
                }}
              >
                Live preview
              </span>
            </div>

            {selectedResourceImage ? (
              <div
                style={{
                  width: "100%",
                  borderRadius: "var(--bf-radius-lg, 14px)",
                  overflow: "hidden",
                  border: `1px solid ${BORDER_SUBTLE}`,
                  background: "var(--bf-preview-card-bg, rgba(0,0,0,0.20))",
                }}
              >
                <img
                  src={selectedResourceImage}
                  alt={selectedResource.name}
                  style={{
                    display: "block",
                    width: "100%",
                    height: "auto",
                    maxHeight: 280,
                    objectFit: "cover",
                  }}
                />
              </div>
            ) : (
              <div
                style={{
                  width: "100%",
                  borderRadius: "var(--bf-radius-lg, 14px)",
                  border: `1px solid ${BORDER_SUBTLE}`,
                  background: "var(--bf-preview-card-bg, rgba(0,0,0,0.20))",
                  padding: 18,
                  color: TEXT_SOFT,
                  fontSize: "var(--bf-type-body-sm-fs, 13px)",
                }}
              >
                No preview image available.
              </div>
            )}
          </div>
        )}

        {/* Time slots */}
        <div ref={slotsRef} style={{ marginTop: 14 }}>
          <div
            style={{
              fontSize: "var(--bf-label-font, 12px)",
              letterSpacing: "var(--bf-label-letter-spacing, 0.12em)",
              textTransform: "var(--bf-label-transform, uppercase)" as any,
              color: `var(--bf-label-color, ${TEXT_MUTED})`,
              marginBottom: "var(--bf-label-gap, 10px)",
            }}
          >
            Time (slots)
          </div>

          {availabilityError && (
            <div
              style={{
                color: "var(--bf-danger, #b91c1c)",
                fontSize: "var(--bf-error-font, 13px)",
                marginBottom: "var(--bf-error-gap, 10px)",
              }}
            >
              {availabilityError}
            </div>
          )}

          {loadingSlots ? (
            <div style={{ color: TEXT_SOFT, fontSize: 13 }}>Loading…</div>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              {timeSlots.map((slot) => {
                const selected = selectedTimes.includes(slot.time);
                const disabled = !slot.available || isPastSlot(slot.time);

                const isBooked = !slot.available;
                const isPast = isPastSlot(slot.time);
                const isDisabled = isBooked || isPast;
                
                const state =
                  isBooked ? (selected ? "bookedSelected" : "booked")
                  : isPast ? (selected ? "disabledSelected" : "disabled")
                  : selected ? "selected"
                  : "default";
                
                return (
                  <PillButton
                    key={slot.time}
                    type="button"
                    state={state}
                    disabled={isDisabled}
                    onClick={() => onToggleSlot(slot.time)}
                    aria-label={`Select ${slot.time}`}
                  >
                    {slot.time}
                  </PillButton>
                );
              })}
            </div>
          )}

          {selectedService && (
            <div
              style={{
                marginTop: 10,
                fontSize: 12,
                color: TEXT_SOFT,
                lineHeight: 1.35,
              }}
            >
              Interval: {intervalMinutes} min · Min: {minSlots} slot(s) · Max:{" "}
              {maxSlots} slot(s)
            </div>
          )}
        </div>

        {/* Confirm */}
        <div style={{ marginTop: 18 }}>
          {submitError && (
            <div
              style={{
                color: "var(--bf-danger, #b91c1c)",
                fontSize: "var(--bf-error-font, 13px)",
                marginBottom: "var(--bf-error-gap, 10px)",
              }}
            >
              {submitError}
            </div>
          )}

          <button
            ref={confirmBtnRef}
            type="submit"
            disabled={!canSubmit}
            style={{
              width: "100%",
              height: "var(--bf-primary-btn-height, 46px)",
              borderRadius: "var(--bf-primary-btn-radius, 12px)",
              border: "none",
              fontWeight: "var(--bf-primary-btn-font-weight, 700)" as any,
              fontSize: "var(--bf-primary-btn-font-size, 14px)",
              letterSpacing: "var(--bf-primary-btn-letter-spacing, 0.02em)",
              paddingLeft: "var(--bf-primary-btn-padding-x, 0px)",
              paddingRight: "var(--bf-primary-btn-padding-x, 0px)",
              background: canSubmit
                ? `var(--bf-primary-btn-bg, ${BRAND_PRIMARY})`
                : "var(--bf-primary-btn-bg-disabled, rgba(255,255,255,0.24))",
              color: canSubmit
                ? "var(--bf-primary-btn-text, rgba(255,255,255,0.92))"
                : "var(--bf-primary-btn-text-disabled, rgba(255,255,255,0.70))",
              cursor: canSubmit ? "pointer" : "not-allowed",
              boxShadow: canSubmit
                ? "var(--bf-primary-btn-shadow, 0 12px 22px rgba(0,0,0,0.35))"
                : "none",
            }}
          >
            Confirm booking
          </button>

          {(canUseMembership || forceShowMembershipToggle) && typeof setUseMembershipCredits === "function" && (
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginTop: 12,
                padding: 10,
                borderRadius: 12,
                border: `1px solid ${BORDER_SUBTLE}`,
                background: PAGE_BG,
                color: TEXT_MAIN,
                opacity: membershipToggleDisabled ? 0.7 : 1,
              }}
            >
              <input
                type="checkbox"
                checked={!!useMembershipCredits}
                disabled={!!membershipToggleDisabled}
                onChange={(e) => setUseMembershipCredits(e.target.checked)}
                style={{ width: 16, height: 16 }}
              />
              <div style={{ lineHeight: 1.2 }}>
                <div style={{ fontSize: "var(--bf-type-body-sm-fs, 13px)", fontWeight: 700 }}>{membershipLabel}</div>
                <div style={{ fontSize: 12, color: TEXT_MUTED, marginTop: 2 }}>
                  {membershipToggleDisabled
                    ? membershipToggleHint || "No usable membership credits available for this service right now."
                    : "If checked, we’ll automatically apply your next eligible membership entitlement."}
                </div>
              </div>
            </label>
          )}


          {selectedService && minSlotsSafe > 1 && selectedTimes.length < minSlotsSafe && (
            <div
              style={{
                marginTop: 10,
                textAlign: "center",
                fontSize: 12,
                color: TEXT_MUTED,
              }}
            >
              This service requires at least {minSlotsSafe} consecutive slot(s).{" "}
              {selectedTimes.length > 0
                ? `Select ${minSlotsSafe - selectedTimes.length} more to continue.`
                : "Pick a start time and we’ll select the minimum automatically."}
            </div>
          )}

          {selectedTimes.length > 0 && (
            <div
              style={{
                marginTop: 10,
                textAlign: "center",
                fontSize: 12,
                color: TEXT_SOFT,
              }}
            >
              Selected: {selectedTimes.length} slot(s) ·{" "}
              {selectedDurationMinutes} minutes
            </div>
          )}
        </div>
      </form>
    </section>
  );
}