import type { Conversation, Health, KnowledgeBase, KnowledgeDocument, KnowledgeVersion, Message, RagflowConfig, User } from './types';

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(path, { ...options, headers, credentials: 'include' });
  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try {
      const body = (await response.json()) as { detail?: string };
      message = body.detail || message;
    } catch {
      // The status code remains actionable when an upstream returns no JSON body.
    }
    throw new ApiError(message, response.status);
  }
  return response.json() as Promise<T>;
}

export const api = {
  login: (username: string, password: string) =>
    request<{ user: User }>('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request<{ success: boolean }>('/api/v1/auth/logout', { method: 'POST' }),
  me: () => request<{ user: User }>('/api/v1/auth/me'),
  dashboard: () =>
    request<{ metrics: Record<string, number>; knowledge_bases: KnowledgeBase[] }>('/api/v1/dashboard'),
  health: () => request<Health>('/api/v1/health'),
  ragflowConfig: () => request<RagflowConfig>('/api/v1/admin/ragflow/config'),
  updateRagflowConfig: (apiKey: string) =>
    request<RagflowConfig>('/api/v1/admin/ragflow/config', { method: 'PUT', body: JSON.stringify({ api_key: apiKey }) }),
  knowledgeBases: () => request<{ items: KnowledgeBase[] }>('/api/v1/knowledge-bases'),
  createKnowledgeBase: (payload: { name: string; description: string }) =>
    request<KnowledgeBase>('/api/v1/knowledge-bases', { method: 'POST', body: JSON.stringify(payload) }),
  updateKnowledgeBase: (knowledgeBaseId: string, payload: { name: string; description: string }) =>
    request<KnowledgeBase>(`/api/v1/knowledge-bases/${knowledgeBaseId}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteKnowledgeBase: (knowledgeBaseId: string) =>
    request<{ success: boolean }>(`/api/v1/knowledge-bases/${knowledgeBaseId}`, { method: 'DELETE' }),
  versions: (knowledgeBaseId: string) =>
    request<{ items: KnowledgeVersion[] }>(`/api/v1/knowledge-bases/${knowledgeBaseId}/versions`),
  createVersion: (knowledgeBaseId: string) =>
    request<KnowledgeVersion>(`/api/v1/knowledge-bases/${knowledgeBaseId}/versions`, { method: 'POST' }),
  updateVersion: (knowledgeBaseId: string, versionId: string, name: string) =>
    request<KnowledgeVersion>(`/api/v1/knowledge-bases/${knowledgeBaseId}/versions/${versionId}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  deleteVersion: (knowledgeBaseId: string, versionId: string) =>
    request<{ success: boolean }>(`/api/v1/knowledge-bases/${knowledgeBaseId}/versions/${versionId}`, { method: 'DELETE' }),
  documents: (knowledgeBaseId: string, versionId: string) =>
    request<{ items: KnowledgeDocument[] }>(`/api/v1/knowledge-bases/${knowledgeBaseId}/versions/${versionId}/documents`),
  uploadDocument: (knowledgeBaseId: string, versionId: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<{ items: KnowledgeDocument[] }>(
      `/api/v1/knowledge-bases/${knowledgeBaseId}/versions/${versionId}/documents`,
      { method: 'POST', body: form },
    );
  },
  updateDocument: (knowledgeBaseId: string, versionId: string, documentId: string, name: string) =>
    request<KnowledgeDocument>(`/api/v1/knowledge-bases/${knowledgeBaseId}/versions/${versionId}/documents/${documentId}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  deleteDocument: (knowledgeBaseId: string, versionId: string, documentId: string) =>
    request<{ success: boolean }>(`/api/v1/knowledge-bases/${knowledgeBaseId}/versions/${versionId}/documents/${documentId}`, { method: 'DELETE' }),
  publishVersion: (knowledgeBaseId: string, versionId: string) =>
    request<KnowledgeVersion>(`/api/v1/knowledge-bases/${knowledgeBaseId}/versions/${versionId}/publish`, { method: 'POST' }),
  conversations: () => request<{ items: Conversation[] }>('/api/v1/conversations'),
  createConversation: (knowledgeBaseIds: string[], title: string) =>
    request<Conversation>('/api/v1/conversations', {
      method: 'POST',
      body: JSON.stringify({ knowledge_base_ids: knowledgeBaseIds, title }),
    }),
  deleteConversation: (conversationId: string) =>
    request<{ success: boolean }>(`/api/v1/conversations/${conversationId}`, { method: 'DELETE' }),
  messages: (conversationId: string) =>
    request<{ items: Message[] }>(`/api/v1/conversations/${conversationId}/messages`),
  sendMessage: (conversationId: string, content: string) =>
    request<{ user_message: Message; assistant_message: Message; knowledge_version: number }>(
      `/api/v1/conversations/${conversationId}/messages`,
      { method: 'POST', body: JSON.stringify({ content }) },
    ),
};
