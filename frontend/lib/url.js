/** Returns the URL if it is an absolute http(s) link, otherwise null. */
export function safeHttpUrl(raw) {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Returns the value if it is a base64 data URL (attachments), otherwise null. */
export function safeDataUrl(raw) {
  return typeof raw === "string" && /^data:[a-z0-9.+-]+\/[a-z0-9.+-]+(;[a-z0-9.+-]+=[a-z0-9.+-]+)*;base64,/i.test(raw)
    ? raw
    : null;
}

/** True if the URL points at this app itself (unsafe to embed in a scripted iframe). */
export function isSameOrigin(raw) {
  if (typeof window === "undefined") return false;
  try {
    return new URL(raw).origin === window.location.origin;
  } catch {
    return false;
  }
}
