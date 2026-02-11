"use client";

import React, { type ReactNode, type CSSProperties } from "react";
import type { BookingHistoryItem } from "@/types/booking";
import { useTheme } from "@/lib/theme/ThemeContext";
import { createCardStyle } from "@/lib/theme/styles";

type ThemeTokenProps = {
  /**
   * Optional legacy tokens. If provided by a parent, they will be used.
   * Otherwise this component will derive values from the theme context.
   */
  CARD_STYLE?: CSSProperties;
  BORDER_SUBTLE?: string;
  PAGE_BG?: string;
  TEXT_MAIN?: string;
  TEXT_MUTED?: string;
  TEXT_SOFT?: string;
};

type Props = {
  title: string;
  subtitle?: string;
  booking: BookingHistoryItem;
  onClose: () => void;
  primaryButtons?: ReactNode;
} & ThemeTokenProps;

export default function BookingDetailsCard(props: Props) {
  const theme = useTheme();

  const {
    title,
    subtitle,
    booking,
    onClose,
    primaryButtons,

    CARD_STYLE,
    BORDER_SUBTLE: BORDER_SUBTLE_PROP,
    PAGE_BG: PAGE_BG_PROP,
    TEXT_MAIN: TEXT_MAIN_PROP,
    TEXT_MUTED: TEXT_MUTED_PROP,
    TEXT_SOFT: TEXT_SOFT_PROP,
  } = props;

  const BORDER_SUBTLE = BORDER_SUBTLE_PROP ?? `var(--bf-border, )`;
  const PAGE_BG = PAGE_BG_PROP ?? `var(--bf-bg, )`;
  const TEXT_MAIN = TEXT_MAIN_PROP ?? `var(--bf-text, )`;
  const TEXT_MUTED = TEXT_MUTED_PROP ?? `var(--bf-muted, )`;
  const TEXT_SOFT = TEXT_SOFT_PROP ?? theme.text.soft;

  const start = new Date(booking.start_time);
  const duration = booking.duration_minutes || 60;
  const end = new Date(start.getTime() + duration * 60_000);
  const statusRaw = String(booking.status || "").toLowerCase();
  const statusLabel = statusRaw ? statusRaw.charAt(0).toUpperCase() + statusRaw.slice(1) : "—";
  const statusTone =
    statusRaw === "cancelled"
      ? {
          bg: "var(--bf-danger-bg, rgba(239,68,68,0.12))",
          border: "var(--bf-danger-border, rgba(239,68,68,0.45))",
          text: "var(--bf-danger, #ef4444)",
        }
      : statusRaw === "pending"
        ? {
            bg: "var(--bf-warn-bg, rgba(245,158,11,0.12))",
            border: "var(--bf-warn-border, rgba(245,158,11,0.45))",
            text: "var(--bf-warn, #f59e0b)",
          }
        : {
            bg: "var(--bf-success-bg, rgba(34,197,94,0.12))",
            border: "var(--bf-success-border, rgba(34,197,94,0.45))",
            text: "var(--bf-success, #22c55e)",
          };

  const dateLabel = start.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  const timeLabel = `${start.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })} – ${end.toLocaleTimeString(
    undefined,
    { hour: "2-digit", minute: "2-digit" },
  )}`;

  const HEADER_GAP = "var(--bf-details-header-gap, 12px)";
  const TITLE_FS = "var(--bf-details-title-fs, 18px)";
  const SUBTITLE_FS = "var(--bf-details-subtitle-fs, 13px)";
  const BOX_MT = "var(--bf-details-box-mt, 12px)";
  const BOX_RADIUS = "var(--bf-details-box-radius, 12px)";
  // Slightly tighter padding to preserve width on mobile
  const BOX_PAD = "var(--bf-details-box-pad, 12px)";
  // Fewer "cards inside cards" — use a clean grid with dividers
  const GRID_GAP = "var(--bf-details-grid-gap, 16px)";
  const LABEL_FS = "var(--bf-details-label-fs, 11px)";
  const LABEL_MB = "var(--bf-details-label-mb, 4px)";

  const HR = `1px solid ${BORDER_SUBTLE}`;
  const microLabelStyle: CSSProperties = {
    fontSize: LABEL_FS,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    color: TEXT_SOFT,
    marginBottom: LABEL_MB,
  };

  const valueStyle: CSSProperties = {
    color: TEXT_MAIN,
    fontWeight: 500,
    lineHeight: 1.25,
    wordBreak: "break-word",
  };

  const smallValueStyle: CSSProperties = {
    color: TEXT_MAIN,
    lineHeight: 1.25,
    wordBreak: "break-word",
  };

  // Normalize fields because some call sites pass camelCase (confirmation state),
  // while API responses are snake_case (history/details).
  const booking_code = (booking as any).booking_code ?? (booking as any).bookingCode ?? null;
  const created_at_raw =
    (booking as any).created_at ??
    (booking as any).createdAt ??
    (booking as any).createdAtIso ??
    null;

  const customer_name = (booking as any).customer_name ?? (booking as any).customerName ?? null;
  const customer_email = (booking as any).customer_email ?? (booking as any).customerEmail ?? null;
  const customer_phone = (booking as any).customer_phone ?? (booking as any).customerPhone ?? null;

  const membership_plan_name =
    (booking as any).membership_plan_name ?? (booking as any).membershipPlanName ?? null;
  const toNumberOrNull = (v: any): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };

  const membership_minutes_used_for_booking = toNumberOrNull(
    (booking as any).membership_minutes_used_for_booking ?? (booking as any).membershipMinutesUsedForBooking,
  );
  const membership_minutes_remaining = toNumberOrNull(
    (booking as any).membership_minutes_remaining ?? (booking as any).membershipMinutesRemaining,
  );
  const membership_uses_used_for_booking = toNumberOrNull(
    (booking as any).membership_uses_used_for_booking ?? (booking as any).membershipUsesUsedForBooking,
  );
  const membership_uses_remaining = toNumberOrNull(
    (booking as any).membership_uses_remaining ?? (booking as any).membershipUsesRemaining,
  );

  const bookingCodeLabel = booking_code ? String(booking_code) : `#${booking.id}`;
  const createdAt = created_at_raw ? new Date(created_at_raw) : null;

  const customerName = customer_name ?? "";
  const customerEmail = customer_email ?? null;
  const customerPhone = customer_phone ?? null;

  // Reuse the normalized status computed above (statusRaw/statusLabel/statusTone)
  const prettyStatus = statusLabel;

  const formatMinutes = (mins: number) => {
    if (!Number.isFinite(mins)) return "—";
    const hours = mins / 60;
    // show X hours when it's clean, otherwise minutes
    if (hours >= 1) {
      const fixed = Math.round(hours * 10) / 10;
      return `${fixed} hour${fixed === 1 ? "" : "s"}`;
    }
    return `${mins} minute${mins === 1 ? "" : "s"}`;
  };


  return (
    <section style={CARD_STYLE ?? createCardStyle(theme)}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", gap: HEADER_GAP, alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
            <h2
              style={{
                fontSize: TITLE_FS,
                fontWeight: "var(--bf-heading-weight, 700)",
                margin: 0,
                letterSpacing: "-0.01em",
                color: TEXT_MAIN,
              }}
            >
              {title}
            </h2>

          </div>

          {/* Reference (value only) */}
          <div style={{ marginTop: 4, fontSize: "var(--bf-type-body-sm-fs, 13px)", color: TEXT_MUTED }}>
            {bookingCodeLabel}
          </div>

          <p style={{ fontSize: SUBTITLE_FS, color: TEXT_MUTED, margin: "4px 0 0" }}>
            {subtitle ?? "Here’s your booking summary."}
          </p>
        </div>

        <button
          type="button"
          onClick={onClose}
          style={{
            border: "none",
            background: "transparent",
            cursor: "pointer",
            fontSize: "var(--bf-type-title-lg-fs, 22px)",
            lineHeight: 1,
            color: TEXT_MUTED,
            padding: 0,
          }}
          aria-label="Close"
        >
          ×
        </button>
      </div>

      <div
        style={{
          marginTop: BOX_MT,
          borderRadius: BOX_RADIUS,
          border: `1px solid ${BORDER_SUBTLE}`,
          background: PAGE_BG,
          padding: BOX_PAD,
        }}
      >
        {/* Invoice top row: reference + created */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
            paddingBottom: 12,
            borderBottom: HR,
            marginBottom: 12,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={microLabelStyle}>Status</div>
            <div style={valueStyle}>{prettyStatus}</div>
          </div>

          <div style={{ minWidth: 0, textAlign: "right" as const }}>
            <div style={microLabelStyle}>Created</div>
            <div style={smallValueStyle}>
              {createdAt ? createdAt.toLocaleString() : "—"}
            </div>
          </div>
        </div>

        {/* Invoice body: 2-column grid without nested cards */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
            gap: GRID_GAP,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: "var(--bf-type-body-sm-fs, 13px)", fontWeight: 700, color: TEXT_MAIN, marginBottom: 8 }}>
              Customer
            </div>

            <div style={{ display: "grid", gap: 6 }}>
              <div style={{ fontWeight: 700, color: TEXT_MAIN, fontSize: "var(--bf-type-body-fs, 14px)" }}>
                {customerName || "—"}
              </div>
              {customerEmail ? <div style={smallValueStyle}>{customerEmail}</div> : null}
              {customerPhone ? <div style={smallValueStyle}>{customerPhone}</div> : null}
            </div>
          </div>

          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: "var(--bf-type-body-sm-fs, 13px)", fontWeight: 700, color: TEXT_MAIN, marginBottom: 8 }}>
              Reservation
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                gap: 10,
              }}
            >
              <div>
                <div style={microLabelStyle}>Date</div>
                <div style={valueStyle}>{dateLabel}</div>
              </div>
              <div>
                <div style={microLabelStyle}>Time</div>
                <div style={valueStyle}>{timeLabel}</div>
              </div>
              <div>
                <div style={microLabelStyle}>Service</div>
                <div style={valueStyle}>{booking.service_name ?? "—"}</div>
              </div>
              <div>
                <div style={microLabelStyle}>Duration</div>
                <div style={valueStyle}>{duration} minutes</div>
              </div>
              {!!booking.resource_name && (
                <div style={{ gridColumn: "1 / -1" }}>
                  <div style={microLabelStyle}>Resource</div>
                  <div style={valueStyle}>{booking.resource_name}</div>
                </div>
              )}
              {!!booking.staff_name && (
                <div style={{ gridColumn: "1 / -1" }}>
                  <div style={microLabelStyle}>Staff</div>
                  <div style={valueStyle}>{booking.staff_name}</div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Membership (only when used) */}
        {(booking.customer_membership_id || membership_plan_name) && (
          <div
            style={{
              marginTop: 12,
              paddingTop: 12,
              borderTop: HR,
            }}
          >
            <div style={{ fontSize: "var(--bf-type-body-sm-fs, 13px)", fontWeight: 700, color: TEXT_MAIN, marginBottom: 8 }}>
              Membership
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
              <div>
                <div style={microLabelStyle}>Plan</div>
                <div style={valueStyle}>{membership_plan_name ?? "—"}</div>
              </div>

              {typeof membership_minutes_used_for_booking === "number" ? (
                <div>
                  <div style={microLabelStyle}>Used</div>
                  <div style={valueStyle}>{formatMinutes(Math.abs(membership_minutes_used_for_booking))}</div>
                </div>
              ) : null}

              {typeof membership_minutes_remaining === "number" ? (
                <div>
                  <div style={microLabelStyle}>Balance</div>
                  <div style={valueStyle}>{formatMinutes(membership_minutes_remaining)}</div>
                </div>
              ) : null}

              {typeof membership_uses_used_for_booking === "number" ? (
                <div>
                  <div style={microLabelStyle}>Used (uses)</div>
                  <div style={valueStyle}>{Math.abs(membership_uses_used_for_booking)}</div>
                </div>
              ) : null}

              {typeof membership_uses_remaining === "number" ? (
                <div>
                  <div style={microLabelStyle}>Balance (uses)</div>
                  <div style={valueStyle}>{membership_uses_remaining}</div>
                </div>
              ) : null}
            </div>
          </div>
        )}

        {primaryButtons ? (
          <div
            style={{
              marginTop: 12,
              paddingTop: 12,
              borderTop: HR,
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            {primaryButtons}
          </div>
        ) : null}
      </div>
    </section>
  );
}
