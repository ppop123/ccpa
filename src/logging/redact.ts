const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const API_KEY_RE = /\bsk-[A-Za-z0-9_-]{8,}\b/g;

export function redactForLog(value: unknown): string {
  return String(value)
    .replace(API_KEY_RE, "[api-key:redacted]")
    .replace(EMAIL_RE, "[email:redacted]");
}

export function redactProxyUrlForLog(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return redactForLog(value);
  }
}
