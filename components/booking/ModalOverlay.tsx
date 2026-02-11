// components/booking/ModalOverlay.tsx
"use client";

import React, { ReactNode, useEffect } from "react";

type Props = {
  children: ReactNode;
  onClose?: () => void;
  closeOnBackdrop?: boolean;

  /**
   * Optional override for the modal content max width.
   * Defaults to the existing bf token or a sane fallback.
   */
  maxWidth?: string;
};

// Themeable modal spacing tokens (all optional):
// --bf-modal-top-pad, --bf-modal-bottom-pad, --bf-modal-side-pad
// --bf-modal-blur
// Backdrop defaults to canonical --surface-overlay
// Z-index defaults to canonical --z-modal

// Use clamp so mobile doesn't lose too much vertical space.
// Default keeps a clear gap under the top-right hamburger + allows the logo behind to remain visible.
const TOP_PAD = "var(--bf-modal-top-pad, clamp(56px, 8vh, 124px))";
const BOTTOM_PAD = "var(--bf-modal-bottom-pad, clamp(12px, 5vh, 44px))";
const SIDE_PAD = "var(--bf-modal-side-pad, 12px)";

const BACKDROP = "var(--bf-modal-backdrop, var(--surface-overlay, rgba(15,23,42,0.6)))";
const BLUR = "var(--bf-modal-blur, 0px)";

export default function ModalOverlay({
  children,
  onClose,
  closeOnBackdrop = false,
  maxWidth,
}: Props) {
  // Lock background scroll while modal is open.
  // We still allow scrolling INSIDE the modal content area.
  useEffect(() => {
    const body = document.body;
    const prevOverflow = body.style.overflow;
    const prevPosition = body.style.position;
    const prevTop = body.style.top;
    const prevWidth = body.style.width;

    const scrollY = window.scrollY || 0;

    // iOS/Android friendly scroll lock
    body.style.overflow = "hidden";
    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.width = "100%";

    return () => {
      body.style.overflow = prevOverflow;
      body.style.position = prevPosition;
      body.style.top = prevTop;
      body.style.width = prevWidth;
      window.scrollTo(0, scrollY);
    };
  }, []);

  const resolvedMaxW = maxWidth ?? "var(--bf-modal-max-w, min(860px, 96vw))";

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget && onClose) onClose();
        e.stopPropagation();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        inset: 0,
        background: BACKDROP,
        backdropFilter: `blur(${BLUR})`,
        WebkitBackdropFilter: `blur(${BLUR})`,
        // Make sure the overlay sits above the header/hamburger so background UI can't be interacted with.
        zIndex: 1000,

        // Center the modal frame; the CONTENT inside the frame is the only scroll region.
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",

        paddingTop: TOP_PAD,
        paddingRight: SIDE_PAD,
        paddingLeft: SIDE_PAD,
        paddingBottom: BOTTOM_PAD,

        // prevent the page behind from "rubber band" scroll on mobile
        overscrollBehavior: "contain",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: resolvedMaxW,
          // Use dynamic viewport height so mobile browser UI doesn't cut content
          maxHeight: `calc(100dvh - ${TOP_PAD} - ${BOTTOM_PAD})`,
          minHeight: 0,

          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            WebkitOverflowScrolling: "touch",
            overscrollBehavior: "contain",
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
