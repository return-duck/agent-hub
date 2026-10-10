/**
 * HTTP 节点用的请求。域名白名单、协议限制与超时和 http_get 工具同一套策略：
 * URL 虽然是图作者写的，不设限仍然可以把运行时变成内网探针。
 */
import { TRUNCATION_MARKER } from './httpGet.js';

export interface HttpRequestOptions {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  allowlist: string[];
  timeoutMs: number;
  maxChars: number;
}

export interface HttpCallResult {
  status: number;
  ok: boolean;
  url: string;
  headers: Record<string, string>;
  body: string;
  json: unknown | null;
  truncated: boolean;
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

function hostAllowed(hostname: string, allowlist: string[]): boolean {
  const host = hostname.toLowerCase();
  return allowlist.some((entry) => {
    const allowed = entry.toLowerCase();
    return host === allowed || host.endsWith(`.${allowed}`);
  });
}

export function assertHttpUrl(url: string, allowlist: string[]): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`非法 URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`只支持 http/https，收到: ${parsed.protocol}`);
  }
  if (!hostAllowed(parsed.hostname, allowlist)) {
    throw new Error(`域名 ${parsed.hostname} 不在白名单内（TOOL_HTTP_ALLOWLIST=${allowlist.join(',')}）`);
  }
  return parsed;
}

export async function httpRequest(options: HttpRequestOptions): Promise<HttpCallResult> {
  const method = options.method.toUpperCase();
  if (!METHODS.has(method)) {
    throw new Error(`不支持的 HTTP 方法: ${options.method}`);
  }
  const parsed = assertHttpUrl(options.url, options.allowlist);
  const headers = new Headers(options.headers);
  if (!headers.has('accept')) {
    headers.set('accept', 'application/json, text/plain, text/html;q=0.8, */*;q=0.5');
  }
  const sendBody = method !== 'GET' && method !== 'DELETE' ? options.body : undefined;

  const response = await fetch(parsed, {
    method,
    headers,
    body: sendBody && sendBody.length > 0 ? sendBody : undefined,
    redirect: 'follow',
    signal: AbortSignal.timeout(options.timeoutMs),
  });

  const raw = await response.text();
  const truncated = raw.length > options.maxChars;
  const body = truncated ? raw.slice(0, options.maxChars) + TRUNCATION_MARKER : raw;
  const contentType = response.headers.get('content-type') ?? '';
  let json: unknown | null = null;
  if (contentType.includes('json') || body.trim().startsWith('{') || body.trim().startsWith('[')) {
    try {
      json = JSON.parse(body.replace(TRUNCATION_MARKER, ''));
    } catch {
      json = null;
    }
  }

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  return {
    status: response.status,
    ok: response.ok,
    url: response.url || parsed.toString(),
    headers: responseHeaders,
    body,
    json,
    truncated,
  };
}

const SECRET_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'x-api-key', 'api-key']);

/** 日志里不回显凭证头 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SECRET_HEADERS.has(key.toLowerCase()) ? '***' : value;
  }
  return out;
}
