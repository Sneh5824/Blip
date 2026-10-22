// Backend base URL for HTTP and Socket.IO. NEXT_PUBLIC_* values are inlined at
// build time, so set NEXT_PUBLIC_BACKEND_URL in Vercel before building.
// Development falls back to the local backend; production never targets localhost.
const fromEnv = process.env.NEXT_PUBLIC_BACKEND_URL;

export const BACKEND_URL = (fromEnv || (process.env.NODE_ENV === "production" ? "" : "http://localhost:5001"))
  .trim()
  .replace(/\/+$/, "");

/** Download/view URL for a chat attachment stored on the backend. */
export function attachmentUrl(roomId, attachmentId) {
  if (!roomId || !attachmentId) return null;
  return `${BACKEND_URL}/api/rooms/${encodeURIComponent(roomId)}/attachments/${encodeURIComponent(attachmentId)}`;
}
