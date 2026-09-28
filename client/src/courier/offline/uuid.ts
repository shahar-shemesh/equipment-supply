//the operation id of a queued report. generated once when the courier taps send and never again: a retry, a reload or
//a restart sends the same id, that is what lets the server treat a resend as a replay instead of a second attempt.
//crypto.randomUUID only exists in a secure context, so plain http on a lan gets a v4 built from getRandomValues
export function newOperationId(): string {
  const c: any = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
