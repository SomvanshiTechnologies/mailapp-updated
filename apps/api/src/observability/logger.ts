import pino, { type Logger } from "pino";

export type { Logger };

const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "password",
  "*.password",
  "passwordHash",
  "*.passwordHash",
  "ANTHROPIC_API_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "token",
  "*.token",
  "refreshToken",
];

export function createLogger(opts: { level?: string; pretty?: boolean; service?: string } = {}): Logger {
  const level = opts.level ?? process.env.LOG_LEVEL ?? "info";
  const base = { service: opts.service ?? "mailapp", pid: process.pid };
  if (opts.pretty) {
    return pino({
      level,
      base,
      redact: { paths: REDACT_PATHS, censor: "[redacted]" },
      transport: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" } },
    });
  }
  return pino({
    level,
    base,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
}

let rootLogger: Logger | null = null;
export function getLogger(): Logger {
  if (!rootLogger) {
    rootLogger = createLogger({
      pretty: process.env.NODE_ENV !== "production" && process.env.LOG_PRETTY !== "false",
    });
  }
  return rootLogger;
}

export function setLoggerForTests(l: Logger | null): void {
  rootLogger = l;
}
