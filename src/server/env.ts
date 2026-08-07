export function readRuntimeString(
  env: object,
  name: string,
  options: { required?: boolean } = {},
): string | undefined {
  const value = Reflect.get(env, name);
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (options.required) {
    throw new Error(`Missing required runtime secret: ${name}`);
  }
  return undefined;
}

export function readRuntimeNumber(env: object, name: string, fallback: number): number {
  const value = readRuntimeString(env, name);
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
