type LogLevel = "info" | "warn" | "error";
type LogValue = string | number | boolean | null | undefined;

export function requestLogPath(path: string) {
  return path.replace(
    /^(\/api\/(?:external|admin)\/(?:coupons|redemption-codes))\/(?!issuance-status(?:\/|$))[^/]+/,
    "$1/:code",
  );
}

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
