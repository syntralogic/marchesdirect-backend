import winston, { Logger } from 'winston';
import path from 'path';
import fs from 'fs';

// Create logs directory if it doesn't exist
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_FORMAT = process.env.LOG_FORMAT || 'json';

// Winston's own `errors({ stack: true })` format only unwraps the *first*
// argument if it's an Error. Whatever gets passed as the second ("meta")
// argument to logger.error(msg, err) - which is how every catch block in
// this codebase logs errors - goes straight into `...meta` below and gets
// JSON.stringify'd as-is.
//
// Axios errors (used everywhere the AI/BOAMP/PLACE/TED HTTP calls live)
// carry `err.request`/`err.response` which reference each other
// (request.res === response, response.req === request), so JSON.stringify
// throws "Converting circular structure to JSON". That throw happened
// *inside* the winston format pipeline, which logged its own crash instead
// of the original message - so classification batches were failing with a
// useless "Converting circular structure to JSON" instead of the actual
// API error, and nothing ever got logged that explained why.
//
// Fix: sanitize any meta value before it reaches JSON.stringify. Errors
// (including axios errors) are reduced to the fields that are actually
// useful for debugging; everything else goes through a circular-safe
// stringify so a stray circular object anywhere else can never crash
// logging again.
function toSafeMeta(value: unknown, seen: WeakSet<object> = new WeakSet(), depth = 0): unknown {
  if (depth > 6) return '[max depth]';

  if (value instanceof Error) {
    const anyErr = value as any;
    const safe: Record<string, unknown> = {
      message: value.message,
      name: value.name,
      stack: value.stack,
    };
    // Axios error shape: surface the parts worth debugging, skip the
    // circular request/response objects themselves.
    if (anyErr.code) safe.code = anyErr.code;
    if (anyErr.response) {
      safe.responseStatus = anyErr.response.status;
      safe.responseData = toSafeMeta(anyErr.response.data, seen, depth + 1);
    }
    if (anyErr.config?.url) safe.requestUrl = anyErr.config.url;
    return safe;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    return value.map((v) => toSafeMeta(v, seen, depth + 1));
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = toSafeMeta(v, seen, depth + 1);
    }
    return out;
  }
  return value;
}

function safeMetaString(meta: Record<string, unknown>): string {
  if (Object.keys(meta).length === 0) return '';
  const seen = new WeakSet();
  try {
    return JSON.stringify(toSafeMeta(meta), (_key, val) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      return val;
    });
  } catch (stringifyErr: any) {
    return `[unserializable meta: ${stringifyErr?.message || 'unknown error'}]`;
  }
}

const logFormat = LOG_FORMAT === 'json'
  ? winston.format.combine(
      winston.format.errors({ stack: true }),
      winston.format((info) => {
        // Mutate `info` in place rather than returning a new object - a
        // fresh object here would drop the hidden LEVEL/MESSAGE/SPLAT
        // symbols logform attaches to `info`, which silently breaks
        // level-based file routing and the final json() format downstream.
        // Prefixed with `_` on purpose - these are destructured out only to
        // exclude them from `meta` below, never read directly.
        const { level: _level, message: _message, timestamp: _timestamp, service: _service, ...meta } = info;
        const safeMeta = toSafeMeta(meta) as Record<string, unknown>;
        for (const key of Object.keys(meta)) delete (info as any)[key];
        Object.assign(info, safeMeta);
        return info;
      })(),
      winston.format.json()
    )
  : winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.errors({ stack: true }),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        return `[${timestamp}] [${level.toUpperCase()}] ${message} ${safeMetaString(meta)}`;
      })
    );

export const logger: Logger = winston.createLogger({
  level: LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    logFormat
  ),
  defaultMeta: { service: 'procurement-api' },
  transports: [
    // Console output
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          return `[${timestamp}] [${level}] ${message} ${safeMetaString(meta)}`;
        })
      ),
    }),

    // File output - all logs
    new winston.transports.File({
      filename: path.join(logsDir, 'app.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),

    // File output - errors only
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 5242880,
      maxFiles: 5,
    }),
  ],
});

// Export convenience methods
export const log = {
  debug: (msg: string, meta?: any) => logger.debug(msg, meta),
  info: (msg: string, meta?: any) => logger.info(msg, meta),
  warn: (msg: string, meta?: any) => logger.warn(msg, meta),
  error: (msg: string, err?: any) => logger.error(msg, err),
};

// Audit logging
export const auditLog = async (
  userId: string | null,
  companyId: string | null,
  action: string,
  entityType: string,
  entityId: string,
  oldValues: any = null,
  newValues: any = null,
  ipAddress: string = 'unknown'
) => {
  const { db } = require('../config/database');
  
  try {
    await db.query(
      `INSERT INTO audit_logs 
        (user_id, company_id, action, entity_type, entity_id, old_values, new_values, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [userId, companyId, action, entityType, entityId, oldValues, newValues, ipAddress]
    );
  } catch (err) {
    logger.error('Failed to write audit log:', err);
  }
};
