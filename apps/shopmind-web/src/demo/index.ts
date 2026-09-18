// 演示模式的网络层。
//
// 产品前端所有请求都通过 src/api.ts 里的 request() 走 fetch，
// 因此替换 window.fetch 就能整体接管，视图代码一行都不用改。
//
// 必须严格遵守的约定：
// 1. 任何 2xx 都必须返回 JSON 体——api.ts 对成功响应无条件调用 response.json()，
//    返回 204 或空体会抛 SyntaxError，让「操作成功了但界面报错」；
// 2. 错误必须返回 { detail: string }，这是前端唯一识别的错误字段；
// 3. 列表接口返回 { items: [...] }；
// 4. 无 body 的 POST（logout、创建版本、发布）也要能正常处理。

import * as db from './store';
import { DemoError } from './store';

/**
 * 是否为演示构建。
 * 用可选链读取 import.meta.env：该字段只由 Vite 注入，
 * 在纯 Node 环境下导入本模块（例如跑演示层自测）时不会抛错。
 */
export const DEMO_MODE = import.meta.env?.VITE_DEMO_MODE === 'true';

/** 演示账号，用于登录页预填。 */
export const DEMO_CREDENTIALS = db.DEMO_ACCOUNT;

const API_PREFIX = '/api/v1';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function toErrorResponse(error: unknown): Response {
  if (error instanceof DemoError) return json({ detail: error.message }, error.status);
  const message = error instanceof Error ? error.message : '演示模式无法处理该请求';
  return json({ detail: message }, 500);
}

function readJson<T extends object>(init: RequestInit | undefined): T {
  const body = init?.body;
  if (typeof body !== 'string' || !body) return {} as T;
  try {
    return JSON.parse(body) as T;
  } catch {
    return {} as T;
  }
}

/** 上传接口使用 multipart/form-data，字段名为 file。 */
function readFile(init: RequestInit | undefined): File | null {
  const body = init?.body;
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const file = body.get('file');
    return file instanceof File ? file : null;
  }
  return null;
}

type Ctx = {
  match: RegExpExecArray;
  url: URL;
  init: RequestInit | undefined;
};

type Handler = (ctx: Ctx) => Response;

const decode = (value: string | undefined): string => decodeURIComponent(value ?? '');

/** 顺序重要：更具体的路径必须排在带参数的路径之前。 */
const ROUTES: Array<[string, RegExp, Handler]> = [
  // 账号
  ['POST', /^\/auth\/login$/, ({ init }) => {
    const body = readJson<{ username?: string; password?: string }>(init);
    return json(db.login(body.username ?? '', body.password ?? ''));
  }],
  ['POST', /^\/auth\/logout$/, () => json(db.logout())],
  ['GET', /^\/auth\/me$/, () => json(db.me())],

  // 仪表盘与系统状态
  ['GET', /^\/dashboard$/, () => json(db.dashboard())],
  ['GET', /^\/health$/, () => json(db.health())],
  ['GET', /^\/admin\/ragflow\/config$/, () => json(db.getRagflowConfig())],
  ['PUT', /^\/admin\/ragflow\/config$/, ({ init }) => {
    const body = readJson<{ api_key?: string }>(init);
    return json(db.updateRagflowConfig(body.api_key ?? ''));
  }],

  // 知识库
  ['GET', /^\/knowledge-bases$/, () => json(db.listKnowledgeBases())],
  ['POST', /^\/knowledge-bases$/, ({ init }) =>
    json(db.createKnowledgeBase(readJson<{ name: string; description: string }>(init)), 201)],
  ['PATCH', /^\/knowledge-bases\/([^/]+)$/, ({ match, init }) =>
    json(db.updateKnowledgeBase(decode(match[1]), readJson<{ name: string; description: string }>(init)))],
  ['DELETE', /^\/knowledge-bases\/([^/]+)$/, ({ match }) => json(db.deleteKnowledgeBase(decode(match[1])))],

  // 版本
  ['GET', /^\/knowledge-bases\/([^/]+)\/versions$/, ({ match }) => json(db.listVersions(decode(match[1])))],
  ['POST', /^\/knowledge-bases\/([^/]+)\/versions$/, ({ match }) =>
    json(db.createVersion(decode(match[1])), 201)],
  ['POST', /^\/knowledge-bases\/([^/]+)\/versions\/([^/]+)\/publish$/, ({ match }) =>
    json(db.publishVersion(decode(match[1]), decode(match[2])))],
  ['PATCH', /^\/knowledge-bases\/([^/]+)\/versions\/([^/]+)$/, ({ match, init }) =>
    json(db.updateVersion(decode(match[1]), decode(match[2]), readJson<{ name: string }>(init).name ?? ''))],
  ['DELETE', /^\/knowledge-bases\/([^/]+)\/versions\/([^/]+)$/, ({ match }) =>
    json(db.deleteVersion(decode(match[1]), decode(match[2])))],

  // 文档
  ['GET', /^\/knowledge-bases\/([^/]+)\/versions\/([^/]+)\/documents$/, ({ match }) =>
    json(db.listDocuments(decode(match[1]), decode(match[2])))],
  ['POST', /^\/knowledge-bases\/([^/]+)\/versions\/([^/]+)\/documents$/, ({ match, init }) => {
    const file = readFile(init);
    if (!file) throw new DemoError('未收到上传文件', 422);
    return json(db.uploadDocument(decode(match[1]), decode(match[2]), file), 201);
  }],
  ['PATCH', /^\/knowledge-bases\/([^/]+)\/versions\/([^/]+)\/documents\/([^/]+)$/, ({ match, init }) =>
    json(
      db.updateDocument(
        decode(match[1]),
        decode(match[2]),
        decode(match[3]),
        readJson<{ name: string }>(init).name ?? '',
      ),
    )],
  ['DELETE', /^\/knowledge-bases\/([^/]+)\/versions\/([^/]+)\/documents\/([^/]+)$/, ({ match }) =>
    json(db.deleteDocument(decode(match[1]), decode(match[2]), decode(match[3])))],

  // 会话与消息
  ['GET', /^\/conversations$/, () => json(db.listConversations())],
  ['POST', /^\/conversations$/, ({ init }) => {
    const body = readJson<{ knowledge_base_ids?: string[]; title?: string }>(init);
    return json(db.createConversation(body.knowledge_base_ids ?? [], body.title ?? '新客服咨询'), 201);
  }],
  ['GET', /^\/conversations\/([^/]+)\/messages$/, ({ match }) => json(db.listMessages(decode(match[1])))],
  ['POST', /^\/conversations\/([^/]+)\/messages$/, ({ match, init }) => {
    const body = readJson<{ content?: string }>(init);
    return json(db.sendMessage(decode(match[1]), body.content ?? ''), 201);
  }],
  ['DELETE', /^\/conversations\/([^/]+)$/, ({ match }) => json(db.deleteConversation(decode(match[1])))],
];

function resolveRoute(method: string, pathname: string): { handler: Handler; match: RegExpExecArray } | null {
  const relative = pathname.startsWith(API_PREFIX) ? pathname.slice(API_PREFIX.length) : pathname;
  for (const [routeMethod, pattern, handler] of ROUTES) {
    if (routeMethod !== method) continue;
    const match = pattern.exec(relative);
    if (match) return { handler, match };
  }
  return null;
}

function handleApiRequest(method: string, url: URL, init: RequestInit | undefined): Response {
  const route = resolveRoute(method, url.pathname);
  if (!route) {
    return json({ detail: `演示模式未实现该接口：${method} ${url.pathname}` }, 404);
  }
  try {
    return route.handler({ match: route.match, url, init });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * 处理一个演示接口请求。
 * 不是 /api/v1/ 路径时返回 null，调用方应回退到真实 fetch。
 * 单独导出是为了让演示层能在 Node 里被直接测试。
 */
export function handleDemoRequest(rawUrl: string, init?: RequestInit): Promise<Response> | null {
  let url: URL;
  try {
    const base = typeof window === 'undefined' ? 'http://localhost/' : window.location.href;
    url = new URL(rawUrl, base);
  } catch {
    return null;
  }
  if (!url.pathname.startsWith(`${API_PREFIX}/`)) return null;
  const method = (init?.method ?? 'GET').toUpperCase();
  return Promise.resolve(handleApiRequest(method, url, init));
}

/** 安装 fetch 垫片；非 /api/v1/ 请求原样放行。 */
export function installDemoNetwork(): void {
  if (!DEMO_MODE) return;
  if (typeof window === 'undefined') return;
  const target = window as Window & { __shopmindDemoFetch?: boolean };
  if (target.__shopmindDemoFetch) return;

  const originalFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const handled = handleDemoRequest(rawUrl, init);
    if (handled) return handled;
    return originalFetch(input, init);
  };
  target.__shopmindDemoFetch = true;
}

/**
 * 安装演示模式：接管网络并预填演示账号。
 * 必须在渲染前调用——挂载时就会立即请求 /auth/me。
 */
export function installDemo(): void {
  if (!DEMO_MODE) return;
  installDemoNetwork();
  try {
    // 登录页从 localStorage 读取「记住账号」，演示模式直接预填，
    // 访客点一下登录就能进入工作台。
    localStorage.setItem('shopmind-remembered-username', DEMO_CREDENTIALS.username);
  } catch {
    // 隐私模式下不可写时忽略。
  }
}

/** 清空演示数据并刷新页面。 */
export function resetDemo(): void {
  db.resetDemoState();
  window.location.reload();
}
