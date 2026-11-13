// Session status glyphs, reskinned as small RTS-unit-card icons (think
// StarCraft's command card) instead of plain Unicode symbols. SVGs use
// currentColor so .session-status--<state> still drives their color.

import scvPng from "./assets/scv.png";

const ICONS = {
  // The real thing, not an approximation — something is actively out
  // there doing the job, same as an SCV mid-task.
  running: <img src={scvPng} alt="" className="status-icon-scv" />,
  // Comm-chatter bubble — "this one's radioing in, needs an order."
  needs_input: (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M2 3h12v7H6.5l-2.5 2.5V10H2z" strokeLinejoin="round" />
      <path d="M8 5.2v2.3" strokeLinecap="round" />
      <circle cx="8" cy="9" r="0.65" fill="currentColor" stroke="none" />
    </svg>
  ),
  // Hold-position: a unit standing by, waiting on the next order.
  idle: (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="8" cy="8" r="6" />
      <path d="M6.3 5.6v4.8M9.7 5.6v4.8" strokeLinecap="round" />
    </svg>
  ),
  // Mission-complete badge: shield + check.
  succeeded: (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M8 1.4l5.5 2.1v4.3c0 3-2.3 5.6-5.5 6.6-3.2-1-5.5-3.6-5.5-6.6V3.5L8 1.4z" strokeLinejoin="round" />
      <path d="M5.3 8.1l2 2 3.4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  // Same badge, destroyed: shield + X.
  failed: (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M8 1.4l5.5 2.1v4.3c0 3-2.3 5.6-5.5 6.6-3.2-1-5.5-3.6-5.5-6.6V3.5L8 1.4z" strokeLinejoin="round" />
      <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" strokeLinecap="round" />
    </svg>
  ),
};

const FALLBACK = (
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4">
    <rect x="2" y="2" width="12" height="12" rx="2" strokeDasharray="2 2" />
  </svg>
);

export function StatusIcon({ status }) {
  return ICONS[status] || FALLBACK;
}
