"use client";

import { useState, useRef, useEffect } from "react";
import { buildClientAuthHeaders } from "@/lib/auth/buildClientAuthHeaders";

interface Message {
  role: "user" | "assistant";
  content: string;
  quickReplies?: string[];
  bookingConfirmation?: BookingConfirmation | null;
}

interface BookingConfirmation {
  bookingId: string | number;
  service: string;
  when: string;
  duration: number;
  payment: string;
}

interface AiChatWidgetProps {
  tenantSlug: string;
  authToken?: string | null;
  isSignedIn?: boolean;
  customerName?: string | null;
}

function renderMarkdown(text: string) {
  const lines = text.split("\n");
  return lines.map((line, i) => {
    const parts = line.split(/\*\*(.*?)\*\*/g);
    const rendered = parts.map((p, j) =>
      j % 2 === 1 ? <strong key={j}>{p}</strong> : <span key={j}>{p}</span>
    );
    const isBullet = line.trim().startsWith("- ");
    return (
      <div key={i} style={{ marginBottom: isBullet ? 2 : 4 }}>
        {isBullet ? <span>• {rendered.slice(1)}</span> : rendered}
      </div>
    );
  });
}

function extractQuickReplies(content: string, isSignedIn: boolean): string[] {
  const lower = content.toLowerCase();
  if (
    lower.includes("shall i go ahead") ||
    lower.includes("confirm this booking") ||
    lower.includes("would you like me to confirm") ||
    lower.includes("shall i confirm")
  ) {
    return ["Yes, confirm it ✓", "No, cancel"];
  }
  if (lower.includes("check a different date") || lower.includes("different date")) {
    return ["Check tomorrow", "Check this weekend"];
  }
  if (lower.includes("how can i help") || lower.includes("what would you like")) {
    return isSignedIn
      ? ["Check my balance", "Book a simulator"]
      : ["What's available?", "View pricing"];
  }
  return [];
}

// Booking confirmation card component
function BookingConfirmedCard({ booking }: { booking: BookingConfirmation }) {
  return (
    <div
      style={{
        background: "linear-gradient(135deg, #0a0a0a 0%, #1a2a1a 100%)",
        borderRadius: 12,
        padding: "14px 16px",
        border: "1px solid #2a4a2a",
        marginTop: 4,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
        <span style={{ fontSize: 18 }}>✅</span>
        <span style={{ color: "#4ade80", fontWeight: 700, fontSize: 14 }}>
          Booking Confirmed!
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {[
          ["📅", booking.when],
          ["⏱", `${booking.duration} min`],
          ["🏌️", booking.service],
          ["💳", booking.payment],
          ["🔖", `Ref #${booking.bookingId}`],
        ].map(([icon, val], i) => (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 12,
              color: "#e0e0e0",
            }}
          >
            <span style={{ fontSize: 14 }}>{icon}</span>
            <span>{val}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function AiChatWidget({
  tenantSlug,
  authToken,
  isSignedIn,
  customerName,
}: AiChatWidgetProps) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && messages.length === 0) {
      const greeting =
        isSignedIn && customerName
          ? `Hi ${customerName.split(" ")[0]}! I can see your account, bookings, and balance. How can I help you today?`
          : "Hi! Ask me anything about our services, pricing, or availability.";
      setMessages([
        {
          role: "assistant",
          content: greeting,
          quickReplies: isSignedIn
            ? ["Check my balance", "Book a simulator"]
            : ["What services are available?", "View pricing"],
        },
      ]);
    }
  }, [open]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function sendMessage(text?: string) {
    const msg = (text || input).trim();
    if (!msg || loading) return;

    const newMessages: Message[] = [...messages, { role: "user", content: msg }];
    setMessages(newMessages);
    setInput("");
    setLoading(true);

    try {
      const authHeaders = buildClientAuthHeaders(authToken);
      const res = await fetch(`/api/proxy/ai/${tenantSlug}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        credentials: "include",
        body: JSON.stringify({
          message: msg,
          history: newMessages.slice(0, -1).map((m) => ({
            role: m.role,
            content: m.content,
          })),
        }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      const replyContent =
        data.reply || "I processed your request. Is there anything else I can help you with?";
      const quickReplies = extractQuickReplies(replyContent, !!isSignedIn);

      // Build booking confirmation card if booking succeeded
      let bookingConfirmation: BookingConfirmation | null = null;
      if (data.action?.success && data.action?.bookingId) {
        bookingConfirmation = {
          bookingId: data.action.bookingId,
          service: data.action.booking?.booking?.service_name || "Golf Simulator",
          when: data.action.booking?.booking?.start_time
            ? new Date(data.action.booking.booking.start_time).toLocaleString("en-GB", {
                timeZone: "Asia/Amman",
                dateStyle: "full",
                timeStyle: "short",
              })
            : "",
          duration: data.action.booking?.booking?.duration_minutes || 60,
          payment:
            data.action.booking?.booking?.payment_method === "membership"
              ? "Membership credits ✓"
              : data.action.booking?.booking?.payment_method === "package"
              ? "Prepaid package ✓"
              : "Cash at venue",
        };
      }

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: bookingConfirmation ? "" : replyContent,
          quickReplies: bookingConfirmation ? [] : quickReplies,
          bookingConfirmation,
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Something went wrong. Please try again." },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  return (
    <>
      {/* Floating button */}
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          position: "fixed",
          bottom: 80,
          right: 20,
          width: 52,
          height: 52,
          borderRadius: "50%",
          background: "#1a1a1a",
          color: "#fff",
          border: "none",
          cursor: "pointer",
          fontSize: 22,
          boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
          zIndex: 9999,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
        aria-label="Open AI assistant"
      >
        {open ? "✕" : "✦"}
      </button>

      {open && (
        <div
          style={{
            position: "fixed",
            bottom: 140,
            right: 16,
            width: 340,
            maxHeight: 560,
            background: "#fff",
            borderRadius: 16,
            boxShadow: "0 8px 40px rgba(0,0,0,0.18)",
            display: "flex",
            flexDirection: "column",
            zIndex: 9998,
            overflow: "hidden",
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: "12px 16px",
              borderBottom: "1px solid #ececec",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 18 }}>✦</span>
              <span style={{ fontWeight: 600, fontSize: 14 }}>Ask anything</span>
            </div>
            {isSignedIn && (
              <span
                style={{
                  fontSize: 11,
                  background: "#f0f0f0",
                  padding: "2px 8px",
                  borderRadius: 20,
                  color: "#555",
                }}
              >
                Signed in
              </span>
            )}
          </div>

          {/* Messages */}
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "12px 12px 4px",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {messages.map((msg, idx) => (
              <div key={idx}>
                {/* Booking confirmation card (replaces text bubble) */}
                {msg.bookingConfirmation ? (
                  <BookingConfirmedCard booking={msg.bookingConfirmation} />
                ) : (
                  <div
                    style={{
                      display: "flex",
                      justifyContent: msg.role === "user" ? "flex-end" : "flex-start",
                    }}
                  >
                    {msg.content && (
                      <div
                        style={{
                          maxWidth: "84%",
                          padding: "9px 13px",
                          borderRadius:
                            msg.role === "user"
                              ? "14px 14px 4px 14px"
                              : "14px 14px 14px 4px",
                          background: msg.role === "user" ? "#1a1a1a" : "#f3f3f3",
                          color: msg.role === "user" ? "#fff" : "#1a1a1a",
                          fontSize: 13,
                          lineHeight: 1.55,
                        }}
                      >
                        {msg.role === "assistant"
                          ? renderMarkdown(msg.content)
                          : msg.content}
                      </div>
                    )}
                  </div>
                )}

                {/* Quick reply chips */}
                {msg.role === "assistant" &&
                  msg.quickReplies &&
                  msg.quickReplies.length > 0 &&
                  idx === messages.length - 1 &&
                  !loading && (
                    <div
                      style={{
                        display: "flex",
                        gap: 6,
                        flexWrap: "wrap",
                        marginTop: 6,
                        paddingLeft: msg.bookingConfirmation ? 0 : 4,
                      }}
                    >
                      {msg.quickReplies.map((qr) => (
                        <button
                          key={qr}
                          onClick={() => sendMessage(qr)}
                          style={{
                            background: "#1a1a1a",
                            color: "#fff",
                            border: "none",
                            borderRadius: 16,
                            padding: "5px 12px",
                            fontSize: 12,
                            cursor: "pointer",
                            fontWeight: 500,
                          }}
                        >
                          {qr}
                        </button>
                      ))}
                    </div>
                  )}
              </div>
            ))}

            {loading && (
              <div style={{ display: "flex", justifyContent: "flex-start" }}>
                <div
                  style={{
                    padding: "8px 14px",
                    borderRadius: "14px 14px 14px 4px",
                    background: "#f3f3f3",
                    fontSize: 18,
                    letterSpacing: 3,
                    color: "#999",
                  }}
                >
                  •••
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div
            style={{
              padding: "10px 12px",
              borderTop: "1px solid #ececec",
              display: "flex",
              gap: 8,
              alignItems: "center",
            }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                isSignedIn ? "Ask about your balance, bookings..." : "Ask about services, pricing..."
              }
              style={{
                flex: 1,
                border: "1px solid #ddd",
                borderRadius: 20,
                padding: "8px 14px",
                fontSize: 13,
                outline: "none",
                background: "#fafafa",
              }}
              disabled={loading}
              autoFocus
            />
            <button
              onClick={() => sendMessage()}
              disabled={loading || !input.trim()}
              style={{
                background: input.trim() && !loading ? "#1a1a1a" : "#ccc",
                color: "#fff",
                border: "none",
                borderRadius: "50%",
                width: 34,
                height: 34,
                cursor: input.trim() && !loading ? "pointer" : "default",
                fontSize: 16,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              ↑
            </button>
          </div>
        </div>
      )}
    </>
  );
}
