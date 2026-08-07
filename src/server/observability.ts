type LogLevel = "info" | "warn" | "error";
type LogValue = string | number | boolean | null | undefined;

export function logEvent(level: LogLevel, event: string, fields: Record<string, LogValue> = {}) {
  const payload = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields,
  });
  if (level === "error") {
    console.error(payload);
  } else if (level === "warn") {
    console.warn(payload);
  } else {
    console.log(payload);
  }
}
