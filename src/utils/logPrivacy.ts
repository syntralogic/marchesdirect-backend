// Logs contain operational codes/IDs only, never message payloads or credentials.
const PRIVATE_KEY = /^(?:to|from|subject|html|text|body|content|attachments?|recipient|e_?mail|email|phone|telephone|mobile|address|first_?name|last_?name|full_?name|password|token|access_?token|refresh_?token|secret|api_?key|authorization|cookie|set-cookie|headers|request|responseData|params|query|values)$/i;
export function redactLogText(value: string): string {
  return value
    .replace(/<html\b[\s\S]*|<!doctype\b[\s\S]*/gi, '[message content removed]')
    .replace(/https?:\/\/[^\s<>"']+/gi, '[url removed]')
    .replace(/\/[\w/.-]+\?[^\s<>"']+/g, '[request query removed]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:re_|pat-(?:eu\d|na\d)-)[A-Za-z0-9_-]+\b/g, '[credential removed]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[token removed]')
    .replace(/((?:token|password|secret|api[_-]?key|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email removed]')
    .replace(/(?:\+|00)?\d[\d\s.()-]{7,}\d/g, '[number removed]');
}
export function sanitizeLogValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (typeof value === 'string') return redactLogText(value);
  if (depth > 6) return '[max depth]';
  if (Buffer.isBuffer(value)) return '[binary content removed]';
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (value instanceof Error) {
    const error = value as any;
    return { name: value.name, message: redactLogText(value.message), stack: value.stack ? redactLogText(value.stack) : undefined,
      code: typeof error.code === 'string' && /^[A-Z0-9_]{1,50}$/i.test(error.code) ? error.code : undefined,
      status: typeof error.response?.status === 'number' ? error.response.status : undefined };
  }
  if (Array.isArray(value)) return value.map(v => sanitizeLogValue(v, seen, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) out[key] = PRIVATE_KEY.test(key) ? '[redacted]' : sanitizeLogValue(v, seen, depth + 1);
  return out;
}
