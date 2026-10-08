type Event = 'http_rejected' | 'command_rejected' | 'connected' | 'disconnected' | 'wait_timeout' | 'host_changed' | 'room_closed';
type Details = { roomId?: string; code?: string; status?: number; reason?: 'closed' | 'heartbeat_timeout' | 'left' | 'kicked' | 'session_replaced' };
// Fixed fields only: never pass requests, URLs, payloads, tokens or identities.
// Bound rejection/connection logging even when a client repeatedly misbehaves.
let windowStart = 0;
let count = 0;
export function businessLog(event: Event, details: Details = {}) {
  const now = Date.now();
  if (now - windowStart >= 60_000) { windowStart = now; count = 0; }
  if (++count > 60) return;
  console.info(JSON.stringify({ event, roomId: details.roomId, code: details.code, status: details.status, reason: details.reason }));
}
