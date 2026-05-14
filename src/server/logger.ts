import pino from "pino";

export const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: null,
  timestamp: pino.stdTimeFunctions.isoTime,
  serializers: {
    err: pino.stdSerializers.err,
  },
});

/** Returns a child logger with a fixed `component` field for filtering. */
export function childLog(component: string): pino.Logger {
  return log.child({ component });
}
