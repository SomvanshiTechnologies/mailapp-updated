/**
 * Chart palette (validated default from the dataviz reference instance).
 * Categorical slots are assigned in fixed order to fixed entities - never cycled.
 */
export const SERIES = {
  sent: "#2a78d6", // slot 1 blue
  delivered: "#1baf7a", // slot 3 aqua
  opened: "#eb6834", // slot 2 orange
  clicked: "#eda100", // slot 4 yellow
  replied: "#008300", // slot 6 green
  bounced: "#e34948", // slot 8 red
  complained: "#4a3aa7", // slot 7 violet
} as const;

export type SeriesKey = keyof typeof SERIES;

export const SES_SERIES: Record<string, string> = {
  Send: "#2a78d6",
  Delivery: "#1baf7a",
  Open: "#eb6834",
  Click: "#eda100",
  Bounce: "#e34948",
  Complaint: "#4a3aa7",
  Reject: "#e87ba4",
  RenderingFailure: "#8a8984",
  DeliveryDelay: "#8a8984",
};

export const CHART_TEXT = "#52514e";
export const CHART_GRID = "#ecebe7";
export const CHART_MUTED = "#c3c2b7";

export const STATUS = {
  good: "#0ca30c",
  warning: "#fab219",
  serious: "#ec835a",
  critical: "#d03b3b",
} as const;
