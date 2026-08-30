export interface User {
  id: string;
  username: string;
  display_name: string;
  role: string;
}

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string;
  active_version_id: string | null;
  active_version_number: number | null;
  active_version_status: string | null;
  version_count?: number;
  updated_at: string;
}

export interface KnowledgeVersion {
  id: string;
  knowledge_base_id: string;
  version_number: number;
  status: 'draft' | 'active' | 'archived' | 'failed';
  document_count: number;
  name?: string;
  created_at: string;
  published_at: string | null;
}

export interface KnowledgeDocument {
  id: string;
  name: string;
  size: number;
  status: string;
  progress: number;
  error_message: string;
  created_at: string;
}

export interface Conversation {
  id: string;
  title: string;
  knowledge_base_id: string;
  knowledge_base_name: string;
  knowledge_base_ids?: string[];
  knowledge_base_names?: string[];
  knowledge_version_id: string | null;
  updated_at: string;
}

export interface Reference {
  id?: string;
  document_id?: string;
  document_keyword?: string;
  content?: string;
  similarity?: number;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  references: Reference[];
  created_at: string;
}

export interface Health {
  status: 'ok' | 'degraded';
  redis: string;
  ragflow: { reachable: boolean; detail: Record<string, unknown> };
  ragflow_configured: boolean;
  ops_url: string;
  model_policy: string;
}

export interface RagflowConfig {
  configured: boolean;
  masked_key: string;
  env_file_available?: boolean;
  persisted?: boolean;
  requires_restart?: boolean;
}
