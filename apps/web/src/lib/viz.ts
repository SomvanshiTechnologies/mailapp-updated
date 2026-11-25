/**
 * Chart palette (validated default from the dataviz reference instance).
 * Categorical slots are assigned in fixed order to fixed entities - never cycled.
 */
export const SERIES = {
  sent: "#2563eb", // blue
  delivered: "#0d9488", // teal
  opened: "#7c5cd6", // violet
  clicked: "#d97706", // amber
  replied: "#16a34a", // green
  bounced: "#dc2626", // red
  complained: "#be185d", // magenta
} as const;

export type SeriesKey = keyof typeof SERIES;

export const SES_SERIES: Record<string, string> = {
  Send: "#2563eb",
  Delivery: "#0d9488",
  Open: "#7c5cd6",
  Click: "#d97706",
  Bounce: "#dc2626",
  Complaint: "#be185d",
  Reject: "#e87ba4",
  RenderingFailure: "#8a8984",
  DeliveryDelay: "#8a8984",
};

export const CHART_TEXT = "#5b6b81";
export const CHART_GRID = "#e8ecf3";
export const CHART_MUTED = "#c3c2b7";

export const STATUS = {
  good: "#0ca30c",
  warning: "#fab219",
  serious: "#ec835a",
  critical: "#d03b3b",
} as const;
