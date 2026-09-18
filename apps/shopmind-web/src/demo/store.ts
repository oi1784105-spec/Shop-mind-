// 演示模式的内存数据库。
//
// 前端契约里几条「写错就坏」的硬性要求，这里逐条对齐：
// 1. api.ts 对任何 2xx 都会调用 response.json()：所有响应（含 DELETE）都必须有 JSON 体；
// 2. 列表接口必须返回 { items: [...] }，缺 items 会直接抛错白屏；
// 3. 错误只认 { detail: "..." }，并用对应状态码；
// 4. 仪表盘的指标键固定为 knowledge_bases / active_versions / documents / conversations；
// 5. 文档轮询只在状态为 DONE / 3 / FAIL / failed 时停止，所以进行中必须是 RUNNING / UNSTART；
// 6. 时间字段必须是可解析的 ISO 字符串，否则 formatDate 会抛 RangeError。

import {
  DEMO_ACCOUNT,
  PARSE_DURATION_MS,
  SEED_CONVERSATIONS,
  SEED_KNOWLEDGE_BASES,
  buildAnswer,
  buildReferences,
} from './content';
import type { DocumentStatus } from './types';
import type {
  Conversation,
  Health,
  KnowledgeBase,
  KnowledgeDocument,
  KnowledgeVersion,
  Message,
  RagflowConfig,
  User,
} from '../types';

const STORAGE_KEY = 'shopmind_demo_db_v1';
const DB_VERSION = 1;

/** 业务错误：会被转换成 HTTP 状态码与 { detail } 错误体。 */
export class DemoError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'DemoError';
    this.status = status;
  }
}

/** 文档在库里的存储形态：用时间戳表达解析进度，而不是定时器。 */
type StoredDocument = KnowledgeDocument & {
  /** 开始解析的时刻；早于它的时间是「等待解析」。 */
  parse_starts_at?: number;
  /** 解析完成的时刻；超过即视为完成。 */
  parse_ends_at?: number;
};

type StoredVersion = Omit<KnowledgeVersion, 'document_count'> & {
  documents: StoredDocument[];
};

type StoredConversation = Conversation & {
  knowledge_base_ids: string[];
  knowledge_base_names: string[];
  messages: Message[];
};

type DemoState = {
  version: number;
  sequence: number;
  loggedIn: boolean;
  user: User;
  knowledgeBases: Array<{ base: KnowledgeBase; versions: StoredVersion[] }>;
  conversations: StoredConversation[];
  ragflowConfigured: boolean;
  ragflowMaskedKey: string;
};

let state: DemoState | null = null;

function nextId(prefix: string): string {
  const db = load();
  db.sequence += 1;
  return `${prefix}-${db.sequence}`;
}

function freshState(): DemoState {
  return {
    version: DB_VERSION,
    sequence: 5000,
    loggedIn: false,
    user: {
      id: 'user-1',
      username: DEMO_ACCOUNT.username,
      display_name: DEMO_ACCOUNT.display_name,
      role: 'admin',
    },
    knowledgeBases: SEED_KNOWLEDGE_BASES.map((entry) => ({
      base: { ...entry.base },
      versions: entry.versions.map((version) => ({
        ...version,
        documents: version.documents.map((document) => {
          const created = new Date(document.created_at).getTime();
          if (document.status === 'RUNNING') {
            // 首个访问者能在十几秒内看到「解析中 → 已完成」，发布按钮随之点亮。
            return {
              ...document,
              parse_starts_at: created,
              parse_ends_at: created + PARSE_DURATION_MS,
            };
          }
          if (document.status === 'UNSTART') {
            return {
              ...document,
              parse_starts_at: Date.now() + 9_000,
              parse_ends_at: Date.now() + 9_000 + PARSE_DURATION_MS,
            };
          }
          return { ...document };
        }),
      })),
    })),
    conversations: SEED_CONVERSATIONS.map((entry) => {
      const ids = entry.conversation.knowledge_base_id ? [entry.conversation.knowledge_base_id] : [];
      return {
        ...entry.conversation,
        knowledge_base_ids: ids,
        knowledge_base_names: entry.conversation.knowledge_base_name
          ? [entry.conversation.knowledge_base_name]
          : [],
        messages: entry.messages.map((message) => ({ ...message })),
      };
    }),
    ragflowConfigured: false,
    ragflowMaskedKey: '',
  };
}

function persist(): void {
  if (!state) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 隐私模式下 localStorage 不可写时退化为纯内存演示。
  }
}

function load(): DemoState {
  if (state) return state;
  let restored: DemoState | null = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DemoState;
      if (parsed && parsed.version === DB_VERSION) restored = parsed;
    }
  } catch {
    restored = null;
  }
  state = restored ?? freshState();
  persist();
  return state;
}

/** 重置演示数据并回到未登录状态。 */
export function resetDemoState(): void {
  state = freshState();
  persist();
}

export { DEMO_ACCOUNT };

// ---------------------------------------------------------------------------
// 文档解析状态：由时间戳推导，读取时顺带把完成状态落库
// ---------------------------------------------------------------------------

function resolveDocument(document: StoredDocument): KnowledgeDocument {
  const { parse_starts_at: startsAt, parse_ends_at: endsAt, ...rest } = document;

  if (rest.status === 'DONE' || rest.status === 'FAIL' || rest.status === 'CANCEL') {
    return { ...rest, progress: rest.status === 'DONE' ? 1 : rest.progress };
  }

  const now = Date.now();
  if (startsAt !== undefined && now < startsAt) {
    return { ...rest, status: 'UNSTART', progress: 0 };
  }
  if (endsAt !== undefined && now >= endsAt) {
    document.status = 'DONE';
    document.progress = 1;
    delete document.parse_starts_at;
    delete document.parse_ends_at;
    return { ...rest, status: 'DONE', progress: 1 };
  }
  const span = endsAt !== undefined && startsAt !== undefined ? Math.max(1, endsAt - startsAt) : PARSE_DURATION_MS;
  const elapsed = startsAt !== undefined ? now - startsAt : 0;
  const progress = Math.max(0.05, Math.min(0.95, elapsed / span));
  document.status = 'RUNNING';
  document.progress = progress;
  return { ...rest, status: 'RUNNING', progress };
}

function storedVersion(knowledgeBaseId: string, versionId: string): StoredVersion {
  const db = load();
  const entry = db.knowledgeBases.find((item) => item.base.id === knowledgeBaseId);
  const version = entry?.versions.find((item) => item.id === versionId);
  if (!entry || !version) throw new DemoError('找不到对应的版本', 404);
  return version;
}

function publicVersion(version: StoredVersion): KnowledgeVersion {
  const { documents, ...rest } = version;
  // document_count 由实际文档数推导，保证与文档增删一致。
  return { ...rest, document_count: documents.length };
}

/** 读取时顺带推进解析进度；有变化就落库，让状态最终收敛。 */
function refreshDocuments(): void {
  const db = load();
  let changed = false;
  for (const entry of db.knowledgeBases) {
    for (const version of entry.versions) {
      version.documents.forEach((document, index) => {
        const before = document.status;
        resolveDocument(document);
        if (document.status !== before) changed = true;
        version.documents[index] = document;
      });
    }
  }
  if (changed) persist();
}

// ---------------------------------------------------------------------------
// 账号
// ---------------------------------------------------------------------------

export function login(username: string, password: string): { user: User } {
  const db = load();
  if (!username.trim() || !password.trim()) {
    throw new DemoError('请输入账号和密码', 422);
  }
  db.loggedIn = true;
  db.user = { ...db.user, username: username.trim() };
  persist();
  return { user: { ...db.user } };
}

export function logout(): { success: boolean } {
  const db = load();
  db.loggedIn = false;
  persist();
  return { success: true };
}

export function me(): { user: User } {
  const db = load();
  if (!db.loggedIn) throw new DemoError('未登录', 401);
  return { user: { ...db.user } };
}

// ---------------------------------------------------------------------------
// 仪表盘与系统状态
// ---------------------------------------------------------------------------

export function dashboard(): { metrics: Record<string, number>; knowledge_bases: KnowledgeBase[] } {
  refreshDocuments();
  const db = load();
  const activeVersions = db.knowledgeBases.reduce(
    (total, entry) => total + entry.versions.filter((version) => version.status === 'active').length,
    0,
  );
  const documents = db.knowledgeBases.reduce(
    (total, entry) => total + entry.versions.reduce((sum, version) => sum + version.documents.length, 0),
    0,
  );

  return {
    metrics: {
      knowledge_bases: db.knowledgeBases.length,
      active_versions: activeVersions,
      documents,
      conversations: db.conversations.length,
    },
    knowledge_bases: db.knowledgeBases.slice(0, 5).map((entry) => ({ ...entry.base })),
  };
}

export function health(): Health {
  const db = load();
  return {
    status: 'ok',
    // 必须是精确的小写 'ok'，否则界面会显示红色的「处理失败」徽标。
    redis: 'ok',
    // ragflow 必须是对象：前端会直接读取 health.ragflow.reachable。
    ragflow: { reachable: true, detail: { engine: 'ragflow', edition: 'demo' } },
    ragflow_configured: db.ragflowConfigured,
    ops_url: 'http://127.0.0.1:8081',
    model_policy: 'RAGFlow 统一管理；演示模式不会调用任何模型服务。',
  };
}

export function getRagflowConfig(): RagflowConfig {
  const db = load();
  return {
    configured: db.ragflowConfigured,
    masked_key: db.ragflowMaskedKey,
    env_file_available: true,
    persisted: true,
    requires_restart: false,
  };
}

export function updateRagflowConfig(apiKey: string): RagflowConfig {
  const db = load();
  const trimmed = apiKey.trim();
  if (trimmed.length < 8) throw new DemoError('API Key 格式不正确，请输入完整密钥', 422);
  db.ragflowConfigured = true;
  db.ragflowMaskedKey = `ragflow-••••••••${trimmed.slice(-4)}`;
  persist();
  return getRagflowConfig();
}

// ---------------------------------------------------------------------------
// 知识库
// ---------------------------------------------------------------------------

export function listKnowledgeBases(): { items: KnowledgeBase[] } {
  refreshDocuments();
  const db = load();
  return {
    items: db.knowledgeBases.map((entry) => {
      const versions = entry.versions.map(publicVersion);
      const active = versions.find((version) => version.status === 'active') ?? null;
      return {
        ...entry.base,
        active_version_id: active?.id ?? null,
        active_version_number: active?.version_number ?? null,
        active_version_status: active?.status ?? null,
        version_count: versions.length,
      };
    }),
  };
}

export function createKnowledgeBase(payload: { name: string; description: string }): KnowledgeBase {
  const db = load();
  const name = payload.name.trim();
  if (name.length < 2) throw new DemoError('知识库名称至少需要 2 个字符', 422);
  const id = nextId('kb');
  const base: KnowledgeBase = {
    id,
    name,
    description: payload.description?.trim() ?? '',
    active_version_id: null,
    active_version_number: null,
    active_version_status: null,
    version_count: 1,
    updated_at: new Date().toISOString(),
  };
  db.knowledgeBases = [
    ...db.knowledgeBases,
    {
      base,
      versions: [
        {
          id: `${id}-v1`,
          knowledge_base_id: id,
          version_number: 1,
          status: 'draft',
          name: '初始草稿版本',
          created_at: new Date().toISOString(),
          published_at: null,
          documents: [],
        },
      ],
    },
  ];
  persist();
  return { ...base };
}

function findEntry(knowledgeBaseId: string) {
  const db = load();
  const entry = db.knowledgeBases.find((item) => item.base.id === knowledgeBaseId);
  if (!entry) throw new DemoError('找不到该知识库', 404);
  return entry;
}

export function updateKnowledgeBase(
  knowledgeBaseId: string,
  payload: { name: string; description: string },
): KnowledgeBase {
  const entry = findEntry(knowledgeBaseId);
  const name = payload.name?.trim() || entry.base.name;
  entry.base = {
    ...entry.base,
    name,
    description: payload.description ?? entry.base.description,
    updated_at: new Date().toISOString(),
  };
  persist();
  const [updated] = listKnowledgeBases().items.filter((item) => item.id === knowledgeBaseId);
  // 必须回显完整对象（含 id）：前端用 id 匹配替换列表项，缺字段会让卡片信息回退。
  return updated ?? { ...entry.base };
}

export function deleteKnowledgeBase(knowledgeBaseId: string): { success: boolean } {
  const db = load();
  const exists = db.knowledgeBases.some((item) => item.base.id === knowledgeBaseId);
  if (!exists) throw new DemoError('找不到该知识库', 404);
  db.knowledgeBases = db.knowledgeBases.filter((item) => item.base.id !== knowledgeBaseId);
  db.conversations = db.conversations.filter(
    (conversation) => !conversation.knowledge_base_ids.includes(knowledgeBaseId),
  );
  persist();
  return { success: true };
}

// ---------------------------------------------------------------------------
// 版本
// ---------------------------------------------------------------------------

export function listVersions(knowledgeBaseId: string): { items: KnowledgeVersion[] } {
  refreshDocuments();
  const entry = findEntry(knowledgeBaseId);
  return {
    items: entry.versions
      .slice()
      .sort((a, b) => b.version_number - a.version_number)
      .map(publicVersion),
  };
}

export function createVersion(knowledgeBaseId: string): KnowledgeVersion {
  const entry = findEntry(knowledgeBaseId);
  const nextNumber = entry.versions.reduce((max, version) => Math.max(max, version.version_number), 0) + 1;
  const version: StoredVersion = {
    id: `${knowledgeBaseId}-v${nextNumber}-${Date.now().toString(36)}`,
    knowledge_base_id: knowledgeBaseId,
    version_number: nextNumber,
    status: 'draft',
    name: `V${nextNumber} 草稿`,
    created_at: new Date().toISOString(),
    published_at: null,
    documents: [],
  };
  entry.versions = [...entry.versions, version];
  entry.base.updated_at = new Date().toISOString();
  persist();
  return publicVersion(version);
}

export function updateVersion(
  knowledgeBaseId: string,
  versionId: string,
  name: string,
): KnowledgeVersion {
  const version = storedVersion(knowledgeBaseId, versionId);
  version.name = name?.trim() || version.name;
  persist();
  return publicVersion(version);
}

export function deleteVersion(knowledgeBaseId: string, versionId: string): { success: boolean } {
  const entry = findEntry(knowledgeBaseId);
  const version = entry.versions.find((item) => item.id === versionId);
  if (!version) throw new DemoError('找不到该版本', 404);
  if (version.status === 'active') throw new DemoError('生效版本不能删除，请先发布其他版本', 409);
  entry.versions = entry.versions.filter((item) => item.id !== versionId);
  persist();
  return { success: true };
}

export function publishVersion(knowledgeBaseId: string, versionId: string): KnowledgeVersion {
  const entry = findEntry(knowledgeBaseId);
  const version = entry.versions.find((item) => item.id === versionId);
  if (!version) throw new DemoError('找不到该版本', 404);

  const docs = version.documents.map((document) => resolveDocument(document));
  // 发布门槛与前端保持一致：必须所有文档都是 DONE。
  // 失败与解析中要分开提示，否则「解析失败」被说成「尚未完成」会让人无从下手。
  const failed = docs.filter((document) => document.status === 'FAIL' || document.status === 'CANCEL');
  if (failed.length > 0) {
    throw new DemoError(`有 ${failed.length} 份文档解析失败，请删除或重新上传后再发布`, 409);
  }
  const pending = docs.filter((document) => document.status !== 'DONE');
  if (pending.length > 0) {
    throw new DemoError(`还有 ${pending.length} 份文档正在解析，完成后再发布`, 409);
  }
  if (docs.length === 0) throw new DemoError('当前版本没有文档，无法发布', 409);

  // 与真实系统一致：发布只切换 active 指针，其余生效版本转为归档。
  entry.versions.forEach((item) => {
    if (item.status === 'active') item.status = 'archived';
  });
  version.status = 'active';
  version.published_at = new Date().toISOString();
  entry.base.updated_at = version.published_at;
  persist();
  return publicVersion(version);
}

// ---------------------------------------------------------------------------
// 文档
// ---------------------------------------------------------------------------

export function listDocuments(
  knowledgeBaseId: string,
  versionId: string,
): { items: KnowledgeDocument[] } {
  refreshDocuments();
  const version = storedVersion(knowledgeBaseId, versionId);
  return { items: version.documents.map((document) => resolveDocument(document)) };
}

export function uploadDocument(
  knowledgeBaseId: string,
  versionId: string,
  file: File,
): { items: KnowledgeDocument[] } {
  const version = storedVersion(knowledgeBaseId, versionId);
  if (version.status === 'active') throw new DemoError('生效版本不允许上传文档', 409);

  const startedAt = Date.now();
  const document: StoredDocument = {
    id: nextId('doc'),
    name: file.name,
    size: file.size,
    status: 'RUNNING',
    progress: 0,
    error_message: '',
    created_at: new Date(startedAt).toISOString(),
    parse_starts_at: startedAt,
    // 演示里解析得比真实系统快，方便看到「解析中 → 已完成 → 可发布」。
    parse_ends_at: startedAt + PARSE_DURATION_MS,
  };
  version.documents = [...version.documents, document];
  persist();
  return { items: version.documents.map((item) => resolveDocument(item)) };
}

export function updateDocument(
  knowledgeBaseId: string,
  versionId: string,
  documentId: string,
  name: string,
): KnowledgeDocument {
  const version = storedVersion(knowledgeBaseId, versionId);
  const document = version.documents.find((item) => item.id === documentId);
  if (!document) throw new DemoError('找不到该文档', 404);
  document.name = name?.trim() || document.name;
  persist();
  return resolveDocument(document);
}

export function deleteDocument(
  knowledgeBaseId: string,
  versionId: string,
  documentId: string,
): { success: boolean } {
  const version = storedVersion(knowledgeBaseId, versionId);
  version.documents = version.documents.filter((item) => item.id !== documentId);
  persist();
  return { success: true };
}

// ---------------------------------------------------------------------------
// 会话与消息
// ---------------------------------------------------------------------------

function publicConversation(conversation: StoredConversation): Conversation {
  const { messages, knowledge_base_ids, knowledge_base_names, ...rest } = conversation;
  return {
    ...rest,
    knowledge_base_id: knowledge_base_ids[0] ?? '',
    knowledge_base_ids,
    knowledge_base_names,
  };
}

export function listConversations(): { items: Conversation[] } {
  const db = load();
  return {
    items: db.conversations
      .slice()
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
      .map(publicConversation),
  };
}

export function createConversation(knowledgeBaseIds: string[], title: string): Conversation {
  const db = load();
  const ids = Array.isArray(knowledgeBaseIds) ? knowledgeBaseIds.filter(Boolean) : [];
  if (ids.length === 0) throw new DemoError('请至少选择一个知识库', 422);

  const names = ids.map(
    (id) => db.knowledgeBases.find((entry) => entry.base.id === id)?.base.name ?? '未知知识库',
  );
  const conversation: StoredConversation = {
    id: nextId('conv'),
    title: title?.trim() || '新客服咨询',
    knowledge_base_id: ids[0] ?? '',
    knowledge_base_name: names.join('、'),
    knowledge_base_ids: ids,
    knowledge_base_names: names,
    knowledge_version_id: null,
    updated_at: new Date().toISOString(),
    messages: [],
  };
  db.conversations = [conversation, ...db.conversations];
  persist();
  return publicConversation(conversation);
}

export function deleteConversation(conversationId: string): { success: boolean } {
  const db = load();
  db.conversations = db.conversations.filter((item) => item.id !== conversationId);
  persist();
  return { success: true };
}

export function listMessages(conversationId: string): { items: Message[] } {
  const db = load();
  const conversation = db.conversations.find((item) => item.id === conversationId);
  if (!conversation) throw new DemoError('找不到该会话', 404);
  return { items: conversation.messages.map((message) => ({ ...message })) };
}

export function sendMessage(
  conversationId: string,
  content: string,
): { user_message: Message; assistant_message: Message; knowledge_version: number } {
  refreshDocuments();
  const db = load();
  const conversation = db.conversations.find((item) => item.id === conversationId);
  if (!conversation) throw new DemoError('找不到该会话', 404);
  const question = content?.trim();
  if (!question) throw new DemoError('请输入咨询内容', 422);

  const createdAt = new Date().toISOString();
  const userMessage: Message = {
    id: nextId('msg'),
    role: 'user',
    content: question,
    references: [],
    created_at: createdAt,
  };

  // 只在会话选中的知识库里检索依据，对应产品的「知识依据优先、无依据不编造」。
  const availableDocuments = conversation.knowledge_base_ids.flatMap((id) => {
    const entry = db.knowledgeBases.find((item) => item.base.id === id);
    if (!entry) return [];
    const active = entry.versions.find((version) => version.status === 'active');
    if (!active) return [];
    return active.documents
      .map((document) => resolveDocument(document))
      .filter((document) => document.status === 'DONE')
      .map((document) => ({ name: document.name, knowledgeBaseName: entry.base.name }));
  });

  const references = buildReferences(question, availableDocuments);
  const assistantMessage: Message = {
    id: nextId('msg'),
    role: 'assistant',
    content: buildAnswer(question, references.length),
    references,
    created_at: new Date().toISOString(),
  };

  conversation.messages = [...conversation.messages, userMessage, assistantMessage];
  conversation.updated_at = assistantMessage.created_at;
  if (conversation.title === '新客服咨询') {
    conversation.title = question.slice(0, 30);
  }
  persist();

  const activeVersion = conversation.knowledge_base_ids
    .map((id) => db.knowledgeBases.find((entry) => entry.base.id === id))
    .flatMap((entry) => (entry ? entry.versions : []))
    .find((version) => version.status === 'active');

  return {
    user_message: { ...userMessage },
    assistant_message: { ...assistantMessage },
    knowledge_version: activeVersion?.version_number ?? 0,
  };
}
