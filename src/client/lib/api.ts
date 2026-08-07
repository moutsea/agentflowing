export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type ErrorPayload = {
  error?: string;
  message?: string;
};

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const bodySetsOwnContentType =
    init?.body instanceof FormData ||
    init?.body instanceof URLSearchParams ||
    init?.body instanceof Blob;
  if (init?.body && !bodySetsOwnContentType && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
  });
  const payload = (await response.json().catch(() => ({}))) as T & ErrorPayload;
  if (!response.ok) {
    throw new ApiError(
      payload.message || "The request could not be completed",
      response.status,
      payload.error,
    );
  }
  return payload;
}
