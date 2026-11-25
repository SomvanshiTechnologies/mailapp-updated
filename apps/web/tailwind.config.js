/** @type {import('tailwindcss').Config} */
// Design tokens follow the SupportDesk AI direction: dark navy shell, light canvas, white cards with
// subtle borders, compact enterprise typography (13px body, 32px controls, 36px table rows).
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    fontSize: {
      "2xs": ["0.6875rem", "1rem"],
      xs: ["0.75rem", "1.125rem"],
      sm: ["0.8125rem", "1.25rem"],
      base: ["0.875rem", "1.375rem"],
      lg: ["1rem", "1.5rem"],
      xl: ["1.125rem", "1.625rem"],
      "2xl": ["1.375rem", "1.875rem"],
      "3xl": ["1.625rem", "2.125rem"],
    },
    extend: {
      fontFamily: {
        sans: ['Inter Variable', "Inter", "ui-sans-serif", "system-ui", "-apple-system", '"Segoe UI"', "Roboto", '"Helvetica Neue"', "Arial", '"Noto Sans"', "sans-serif"],
      },
      colors: {
        navy: {
          100: "#dbe6f5",
          300: "#9fb4d3",
          700: "#1c3a66",
          800: "#132a4d",
          900: "#0b1f3a",
          950: "#071226",
        },
        canvas: "#f8f5ee",
        cream: {
          50: "#fcfaf5",
          100: "#f8f5ee",
          200: "#efe9dc",
        },
        brand: {
          50: "#eef4ff",
          100: "#e6efff",
          200: "#bcd0f7",
          300: "#8fb0ee",
          400: "#2f7bf0",
          500: "#2468e0",
          600: "#1f5fd1",
          700: "#184cab",
          800: "#143f8c",
          900: "#0b1f3a",
        },
        gray: {
          50: "#faf8f3",
          100: "#f2eee5",
          200: "#e6e0d3",
          300: "#d3ccbc",
          400: "#8493a8",
          500: "#5b6b81",
          600: "#46566c",
          700: "#334155",
          800: "#1e2b3f",
          900: "#0f1b2d",
        },
      },
      boxShadow: {
        card: "0 1px 2px rgb(15 27 45 / 0.04), 0 1px 1px rgb(15 27 45 / 0.02)",
        pop: "0 8px 24px rgb(15 27 45 / 0.12), 0 1px 3px rgb(15 27 45 / 0.08)",
      },
    },
  },
  plugins: [],
};
