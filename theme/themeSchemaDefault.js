// Canonical Theme Schema (v1)
// This is intentionally minimal: it provides a stable JSON contract for
// Appearance & Brand to edit, while the UI consumes resolved CSS vars.

function defaultThemeSchemaV1() {
  return {
    version: 1,
    editable: {
      colors: {
        primary: "#2563eb",
        accent: "#22c55e",
        background: "#0b1220",
        surface: "#0f172a",
        text: "#f8fafc",
        mutedText: "#94a3b8",
        border: "#1f2937",
      },
      typography: {
        fontFamily: "system",
        headingWeight: 700,
        bodyWeight: 400,
        link: "{colors.accent}",
      },
      radius: {
        card: 16,
        input: 12,
        button: 14,
        pill: 999,
      },
      shadow: {
        level: "soft", // soft | strong
      },
      buttons: {
        style: "solid", // solid | outline
        primary: {
          bg: "{colors.primary}",
          text: "#ffffff",
        },
        secondary: {
          bg: "{derived.surfaceRaised}",
          text: "{colors.text}",
        },
        ghost: {
          text: "{colors.text}",
          hoverBg: "{derived.surfaceRaised}",
        },
        active: {
          bg: "{derived.primaryShade}",
          text: "#ffffff",
        },
        focus: {
          ringWidth: 2,
          ringColor: "{derived.primaryTint}",
        },
        glow: {
          enabled: true,
          source: "primary", // primary | accent
          intensity: "medium", // soft | medium | strong
          spread: "medium", // tight | medium | wide
        },
      },
      nav: {
        item: {
          text: "{colors.text}",
          hoverBg: "{derived.surfaceRaised}",
        },
        activeItem: {
          bg: "{buttons.active.bg}",
          text: "{buttons.active.text}",
          indicator: "none", // none | bar | dot
        },
      },
      pills: {
        bg: "{derived.surfaceRaised}",
        text: "{colors.text}",
        hoverBg: "{derived.surfaceRaised}",
        activeBg: "{buttons.active.bg}",
        activeText: "{buttons.active.text}",
        border: "{colors.border}",
      },
      inputs: {
        bg: "#ffffff",
        text: "#0b1220",
        border: "{colors.border}",
        focusBorder: "{derived.primaryTint}",
        focusBg: "#ffffff",
      },
      status: {
        success: { bg: "{derived.successSoft}", text: "{derived.successText}", border: "{derived.successBorder}" },
        warning: { bg: "{derived.warningSoft}", text: "{derived.warningText}", border: "{derived.warningBorder}" },
        error: { bg: "{derived.errorSoft}", text: "{derived.errorText}", border: "{derived.errorBorder}" },
        info: { bg: "{derived.infoSoft}", text: "{derived.infoText}", border: "{derived.infoBorder}" },
      },
      bookingUI: {
        density: "comfortable",
        showServiceDetailsUnderDropdown: true,
        useLogoAsFavicon: true,
        heroMode: "tabBanners",
      },
    },
    // derived is computed at runtime by the resolver; stored schema may omit it.
    locked: {
      safety: {
        minContrastAA: false,
      },
    },
  };
}

module.exports = { defaultThemeSchemaV1 };
