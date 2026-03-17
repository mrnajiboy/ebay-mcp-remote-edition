import winston from 'winston';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

/**
 * Log directory for eBay MCP Server
 * Stored in user's home directory under .ebay-mcp/logs
 */
const LOG_DIR = join(homedir(), '.ebay-mcp', 'logs');

// Ensure log directory exists
if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * Log level from environment variable or default to 'info'
 * Levels: error, warn, info, http, verbose, debug, silly
 */
const LOG_LEVEL = process.env.EBAY_LOG_LEVEL || 'info';

/**
 * Whether to enable file logging (disabled in production MCP mode by default)
 */
const ENABLE_FILE_LOGGING = process.env.EBAY_ENABLE_FILE_LOGGING === 'true';

/**
 * Custom log format with timestamp and colored output
 */
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ level, message, timestamp, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length ? `\n${JSON.stringify(meta, null, 2)}` : '';
    const stackStr = stack ? `\n${stack}` : '';
    return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}${stackStr}`;
  })
);

/**
 * File format (no colors, JSON for easier parsing)
 */
const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

/**
 * Create Winston logger transports
 */
const transports: winston.transport[] = [
  // Console transport - always enabled for MCP stderr output
  new winston.transports.Console({
    format: consoleFormat,
    stderrLevels: ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'],
  }),
];

// Add file transports if enabled
if (ENABLE_FILE_LOGGING) {
  transports.push(
    // Error log - only errors
    new winston.transports.File({
      filename: join(LOG_DIR, 'error.log'),
      level: 'error',
      format: fileFormat,
      maxsize: 5 * 1024 * 1024, // 5MB
      maxFiles: 5,
      tailable: true,
    }),
    // Combined log - all levels
    new winston.transports.File({
      filename: join(LOG_DIR, 'combined.log'),
      format: fileFormat,
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
      tailable: true,
    }),
    // Debug log - verbose and debug messages
    new winston.transports.File({
      filename: join(LOG_DIR, 'debug.log'),
      level: 'debug',
      format: fileFormat,
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 3,
      tailable: true,
    })
  );
}

/**
 * Main Winston logger instance
 */
const logger = winston.createLogger({
  level: LOG_LEVEL,
  transports,
  exitOnError: false,
});

/**
 * Logger interface for different components
 */
export interface ComponentLogger {
  error: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  http: (message: string, meta?: Record<string, unknown>) => void;
  debug: (message: string, meta?: Record<string, unknown>) => void;
  verbose: (message: string, meta?: Record<string, unknown>) => void;
}

/**
 * Create a child logger for a specific component
 */
export function createLogger(component: string): ComponentLogger {
  return {
    error: (message: string, meta?: Record<string, unknown>) => {
      logger.error(`[${component}] ${message}`, meta);
    },
    warn: (message: string, meta?: Record<string, unknown>) => {
      logger.warn(`[${component}] ${message}`, meta);
    },
    info: (message: string, meta?: Record<string, unknown>) => {
      logger.info(`[${component}] ${message}`, meta);
    },
    http: (message: string, meta?: Record<string, unknown>) => {
      logger.http(`[${component}] ${message}`, meta);
    },
    debug: (message: string, meta?: Record<string, unknown>) => {
      logger.debug(`[${component}] ${message}`, meta);
    },
    verbose: (message: string, meta?: Record<string, unknown>) => {
      logger.verbose(`[${component}] ${message}`, meta);
    },
  };
}

/**
 * Pre-configured loggers for different components
 */
export const serverLogger = createLogger('Server');
export const apiLogger = createLogger('API');
export const authLogger = createLogger('Auth');
export const toolLogger = createLogger('Tool');
export const setupLogger = createLogger('Setup');

/**
 * Log HTTP request details
 */
export function logRequest(
  method: string,
  url: string,
  params?: Record<string, unknown>,
  body?: unknown
): void {
  apiLogger.http(`Request: ${method.toUpperCase()} ${url}`, {
    params: params && Object.keys(params).length > 0 ? params : undefined,
    body: body ? truncateData(body) : undefined,
  });
}

/**
 * Log HTTP response details
 */
export function logResponse(
  status: number,
  statusText: string,
  data?: unknown,
  rateLimitRemaining?: string,
  rateLimitTotal?: string
): void {
  const meta: Record<string, unknown> = {};

  if (rateLimitRemaining && rateLimitTotal) {
    meta.rateLimit = `${rateLimitRemaining}/${rateLimitTotal}`;
  }

  if (data) {
    meta.data = truncateData(data);
  }

  apiLogger.http(`Response: ${status} ${statusText}`, meta);
}

/**
 * Log HTTP error response
 */
export function logErrorResponse(
  status: number | undefined,
  statusText: string | undefined,
  url: string,
  errorData?: unknown
): void {
  apiLogger.error(`Error Response: ${status || 'N/A'} ${statusText || 'No response'}`, {
    url,
    error: errorData ? truncateData(errorData) : undefined,
  });
}

/**
 * Truncate large data objects for logging
 */
function truncateData(data: unknown, maxLength = 1000): unknown {
  const str = JSON.stringify(data);
  if (str.length <= maxLength) {
    return data;
  }
  return `${str.substring(0, maxLength)}... [truncated]`;
}

/**
 * Get log file paths for user reference
 */
export function getLogPaths(): { logDir: string; errorLog: string; combinedLog: string; debugLog: string } {
  return {
    logDir: LOG_DIR,
    errorLog: join(LOG_DIR, 'error.log'),
    combinedLog: join(LOG_DIR, 'combined.log'),
    debugLog: join(LOG_DIR, 'debug.log'),
  };
}

/**
 * Enable or disable file logging at runtime
 */
export function setFileLogging(enabled: boolean): void {
  if (enabled && !ENABLE_FILE_LOGGING) {
    logger.add(
      new winston.transports.File({
        filename: join(LOG_DIR, 'error.log'),
        level: 'error',
        format: fileFormat,
        maxsize: 5 * 1024 * 1024,
        maxFiles: 5,
        tailable: true,
      })
    );
    logger.add(
      new winston.transports.File({
        filename: join(LOG_DIR, 'combined.log'),
        format: fileFormat,
        maxsize: 10 * 1024 * 1024,
        maxFiles: 5,
        tailable: true,
      })
    );
    logger.info('File logging enabled');
  }
}

/**
 * Set log level at runtime
 */
export function setLogLevel(level: string): void {
  logger.level = level;
  logger.info(`Log level set to: ${level}`);
}

export default logger;
