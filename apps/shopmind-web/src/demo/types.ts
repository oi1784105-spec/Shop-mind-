// 演示模式的数据类型。
//
// 产品层的类型直接复用 src/types.ts，避免两边字段漂移：
// 演示层替代的是网络，不是数据结构。

export type {
  Conversation,
  Health,
  KnowledgeBase,
  KnowledgeDocument,
  KnowledgeVersion,
  Message,
  RagflowConfig,
  Reference,
  User,
} from '../types';

/** 文档处理状态。取值与 RAGFlow 的 run 状态一致，前端已有对应中文标签。 */
export type DocumentStatus = 'UNSTART' | 'RUNNING' | 'DONE' | 'FAIL' | 'CANCEL';
