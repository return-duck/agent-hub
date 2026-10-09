/**
 * 应用挂载前缀推导。
 *
 * 同一份构建产物要能挂在三种位置，而 API 又要跟着页面走：
 *   http://<ip>:8080/            挂载前缀 ''        → API /api
 *   http://<ip>/studio/          挂载前缀 '/studio'  → API /studio/api
 *   http://<ip>/studio/a/<slug>  挂载前缀 '/studio'  → API /studio/api
 *
 * 为什么不用相对路径：公开对话页的 URL 是 /a/<slug> 这种"文件形状"的深路径，
 * 相对路径会把它解析成 /a/api/... 而不是 /api/...，直接 404。
 * 所以这里显式把"路由后缀"剥掉，得到挂载前缀，再拼 API 基址。
 */

/** 公开对话页的路由：/<前缀>/a/<slug>，第二个捕获组是 slug */
const AGENT_ROUTE = /^(.*?)\/a\/([^/]+)\/?$/;
/** 调用轨迹页的路由：/<前缀>/a/<slug>/traces —— 必须比对话页更先匹配 */
const TRACE_ROUTE = /^(.*?)\/a\/([^/]+)\/traces\/?$/;

export function mountPrefix(): string {
  const path = window.location.pathname;
  const matched = path.match(TRACE_ROUTE) ?? path.match(AGENT_ROUTE);
  if (matched) {
    return matched[1];
  }
  // 其它情况按"当前目录"推导：去掉最后一段
  const dir = path.replace(/\/[^/]*$/, '');
  return dir === '/' ? '' : dir;
}

/** API 基址，末尾不带斜杠 */
export function apiBase(): string {
  return `${mountPrefix()}/api`;
}

/** 某个 agent 的公开页面路径（用于工作室里展示可复制的链接） */
export function publicAgentPath(slug: string): string {
  return `${mountPrefix()}/a/${slug}`;
}

/** 当前 URL 是否是公开对话页；是则返回 slug（轨迹页不算对话页） */
export function routeSlug(): string | null {
  const matched = window.location.pathname.match(AGENT_ROUTE);
  return matched ? decodeURIComponent(matched[2]) : null;
}

/** 当前 URL 是否是调用轨迹页；是则返回 slug */
export function routeTraceSlug(): string | null {
  const matched = window.location.pathname.match(TRACE_ROUTE);
  return matched ? decodeURIComponent(matched[2]) : null;
}

/** 某个 agent 的调用轨迹页路径 */
export function publicTracePath(slug: string): string {
  return `${mountPrefix()}/a/${slug}/traces`;
}
