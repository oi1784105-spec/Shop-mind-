---
date: 2026-08-26
topic: ragflow-shopmind-bidirectional-sync
---

# ShopMind 与 RAGFlow 双向数据联通设计

## What We're Building

在不复制 RAGFlow 核心数据和密钥的前提下，为 ShopMind 增加统一的同步适配层：ShopMind 负责产品业务、权限、版本和审计，RAGFlow 负责模型提供商、文档处理、索引、检索和生成。两侧通过外部资源映射、事件/轮询同步和可重试任务共享同一套远端资源。

## Why This Approach

当前产品侧可以创建 RAGFlow 数据集、上传文档并发布版本，但运维侧创建的模型或文档不会回流；直接让两边各自保存一份完整数据会产生密钥泄露、重复配置和冲突。推荐“按数据类型确定唯一事实源 + ShopMind 记录映射”的控制面方案。

## Key Decisions

### 1. 数据归属

- RAGFlow 是模型提供商/API 配置、远端数据集、文档解析状态、分块、向量索引、Chat 和 Session 的事实源。
- ShopMind 是企业知识库名称、业务说明、版本发布指针、用户权限、会话审计和产品侧消息记录的事实源。
- API 密钥只保留在 RAGFlow/部署环境；ShopMind 只保存 provider/model 的非敏感引用、能力和同步状态。
- 会话记忆以 ShopMind `messages` 为审计事实源，RAGFlow session 作为推理运行态；发送消息时写入 ShopMind，再同步给 RAGFlow。

### 2. 外部资源映射

新增 `external_resources` 映射表，字段包括：`provider`、`resource_type`、`local_resource_id`、`remote_resource_id`、`remote_revision`、`checksum`、`sync_state`、`last_synced_at`、`last_error`、`deleted_at`。所有产品侧创建/上传和运维侧发现的资源都必须先建立映射，禁止仅靠名称匹配。

### 3. 同步机制

- 产品侧写入：采用同步写穿（创建远端资源成功后再提交本地映射），解析、索引和状态更新采用异步任务。
- 运维侧写入：优先使用 RAGFlow 可用的 webhook；若当前版本没有可靠事件接口，使用 15–30 秒增量轮询，并保存同步游标。
- 同步任务写入 `sync_jobs` 和 outbox 记录，失败按指数退避重试，超过阈值进入死信状态并在页面显示。
- Redis 仅用于同步锁、游标缓存、会话缓存和幂等键；SQLite/后续 MySQL 保存最终业务状态和审计记录。

### 4. 冲突与删除

- 文档内容不原地覆盖：任何修改都创建新的 ShopMind 草稿版本和新的 RAGFlow dataset/document 资源，解析完成后原子切换 active 指针。
- API/model 选择使用版本号或更新时间做乐观并发控制；同一配置同时修改时，保留冲突记录，禁止静默覆盖密钥。
- 元数据冲突默认“管理员确认”，不使用无提示的 last-write-wins。
- 删除采用软删除/墓碑：先标记本地资源，再删除或归档远端资源，确认远端结果后清理索引；历史会话和审计记录保留外部资源 ID。

### 5. 权限边界

- 普通产品用户只能访问自己有权限的 ShopMind 知识库和会话，不能调用 RAGFlow 管理 API。
- 只有 `admin`/运维角色可以查看模型目录、触发全量同步、导入运维侧数据集、查看同步错误和打开 RAGFlow 运维入口。
- ShopMind 后端作为唯一代理，前端不接触 RAGFlow API key；所有同步接口写审计日志。

## API Surface

- `GET /api/v1/admin/ragflow/providers`：管理员查看 RAGFlow 当前 provider/model 目录（脱敏）。
- `POST /api/v1/admin/ragflow/sync`：触发全量或指定资源同步，返回 job_id。
- `GET /api/v1/admin/sync/jobs/{job_id}`：查询同步进度、重试次数和错误。
- `POST /api/v1/internal/ragflow/events`：接收带签名的 RAGFlow webhook；若无 webhook，则由轮询器调用同一套 reconcile service。
- `POST /api/v1/knowledge-bases/{kb_id}/sync`：管理员对单个知识库执行增量对账。
- `GET /api/v1/knowledge-bases/{kb_id}/external-resources`：展示本地版本与远端 dataset/document/chat 的映射状态。
- `GET /api/v1/admin/ragflow/config-status`：只返回是否配置、能力和更新时间，不返回密钥。

## Product Changes

### ShopMind 产品侧

- 设置页增加“模型与连接状态”只读卡片，显示 provider/model 名称、能力、最后同步时间和异常状态。
- 知识库详情增加远端映射、同步状态、重新对账和冲突提示。
- 上传、发布和新建版本继续走 ShopMind API；用户不直接访问 RAGFlow。
- 非管理员隐藏“打开运维页面”入口。

### RAGFlow 运维侧

- 保留现有模型/API、数据集和文档管理界面。
- 对由 ShopMind 创建的资源增加稳定外部标识（metadata/tag/name convention），供同步适配器识别；不得只用展示名称关联。
- 如当前 RAGFlow 版本没有 webhook，新增独立同步 worker，不修改 RAGFlow 核心业务逻辑。

## Non-Goals

- 首期不接入真实订单、物流、退款或售后系统。
- 首期不把 RAGFlow 的全部管理数据复制到 ShopMind。
- 不在 ShopMind 数据库保存 RAGFlow API key、第三方模型密钥或完整 provider secret。
- 不允许普通用户通过产品 API 修改 RAGFlow 全局模型配置。

## Validation Plan

- 产品侧创建知识库、上传文档、发布版本后，RAGFlow 运维页可看到同一 dataset/document。
- 运维侧新增可用模型后，ShopMind 管理接口在一个同步周期内显示该模型，产品创建新版本时可使用该模型引用。
- 运维侧删除/归档文档后，ShopMind 显示冲突或删除状态，不继续把无效文档发布为新版本。
- 同时修改同一元数据时产生冲突记录，不发生静默覆盖。
- 模拟 RAGFlow 超时、Redis 短暂不可用和重复事件，验证幂等、重试、补偿和审计。

## Open Questions

- 需要在目标 RAGFlow 版本中确认 provider/model、dataset/document 的管理 API 是否支持更新时间、版本号、删除状态和 webhook；若不支持，轮询器需要保存本地快照并以内容哈希对账。
- 需要确认是否将同步 worker 与 ShopMind API 放在同一容器，还是拆成独立 `shopmind-sync` 服务；推荐独立进程，便于重试和限流。

## Next Steps

1. 先实现 schema migration、RAGFlow adapter 的资源映射和只读对账接口。
2. 再实现产品侧写入的 outbox、同步任务和 Redis 锁。
3. 接着实现运维侧资源轮询/事件入口、冲突与删除补偿。
4. 最后改造两个页面、补全权限测试和端到端回归测试。
