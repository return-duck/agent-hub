/**
 * 登录态与访客标识的本地存储。
 *
 * 令牌放 localStorage 而不是 cookie：后端用 Authorization 头鉴权，
 * 不需要 CSRF 防护，也不受跨站 Cookie 策略影响。
 * 公开对话页的 visitorId 同样是本地随机生成 —— 它是"这台浏览器在这个 agent 下的身份"，
 * 服务端据此隔离访客之间的会话，不需要访客注册。
 */

const TOKEN_KEY = 'agentstack.token';
const USER_KEY = 'agentstack.user';
const VISITOR_KEY = 'agentstack.visitorId';

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}

export function getToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getStoredUser(): SessionUser | null {
  try {
    const raw = window.localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as SessionUser) : null;
  } catch {
    return null;
  }
}

export function saveSession(token: string, user: SessionUser): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
    window.localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    /* 隐私模式下写不进去也不该让页面崩掉 */
  }
}

export function clearSession(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
    window.localStorage.removeItem(USER_KEY);
  } catch {
    /* 同上 */
  }
}

/** 访客标识：首次访问时生成并持久化，之后这个浏览器就一直用它。 */
export function visitorId(): string {
  try {
    const existing = window.localStorage.getItem(VISITOR_KEY);
    if (existing) {
      return existing;
    }
    const generated =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `v-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    window.localStorage.setItem(VISITOR_KEY, generated);
    return generated;
  } catch {
    // 存储不可用时退化成"每次访问一个新身份"，至少不会崩
    return `v-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}
