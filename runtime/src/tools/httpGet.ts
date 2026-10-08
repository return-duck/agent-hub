/**
 * HTTP GET 工具：带域名白名单、超时与响应截断。
 *
 * 白名单是刻意的默认拒绝策略：工具入参由模型生成，不设限等于把 SSRF / 内网探测
 * 的能力交给模型。MVP 用配置里的白名单，Phase 2 会升级为按 agent 授权的权限模型。
 */
export const TRUNCATION_MARKER = '…[已截断]';

export interface HttpGetResult {
  text: string;
  truncated: boolean;
}

export interface HttpGetOptions {
  allowlist: string[];
  timeoutMs: number;
  maxChars: number;
}

function isAllowed(hostname: string, allowlist: string[]): boolean {
  const host = hostname.toLowerCase();
  return allowlist.some((entry) => {
    const allowed = entry.toLowerCase();
    return host === allowed || host.endsWith(`.${allowed}`);
  });
}

export async function httpGet(url: string, options: HttpGetOptions): Promise<HttpGetResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`非法 URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`只支持 http/https，收到: ${parsed.protocol}`);
  }
  if (!isAllowed(parsed.hostname, options.allowlist)) {
    throw new Error(
      `域名 ${parsed.hostname} 不在白名单内（TOOL_HTTP_ALLOWLIST=${options.allowlist.join(',')}）`,
    );
  }

  const response = await fetch(parsed, {
    method: 'GET',
    redirect: 'follow',
    signal: AbortSignal.timeout(options.timeoutMs),
    headers: { accept: 'text/plain, text/html, application/json;q=0.9, */*;q=0.5' },
  });

  const raw = await response.text();
  const truncated = raw.length > options.maxChars;
  const body = truncated ? raw.slice(0, options.maxChars) + TRUNCATION_MARKER : raw;

  return {
    text: `HTTP ${response.status} ${parsed.hostname}${parsed.pathname}\n${body}`,
    truncated,
  };
}
