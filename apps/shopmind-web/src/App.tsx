import { FormEvent, MouseEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  Database,
  Eye,
  EyeOff,
  FileText,
  Gauge,
  KeyRound,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Menu,
  MessageSquareText,
  Moon,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
  Upload,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ApiError, api } from './api';
import { DEMO_CREDENTIALS, DEMO_MODE } from './demo';
import { DemoBadge } from './demo/DemoBadge';
import type { Conversation, Health, KnowledgeBase, KnowledgeDocument, KnowledgeVersion, Message, User } from './types';

type Theme = 'light' | 'dark';

/**
 * public/ 下静态资源的带 base 地址。
 * 部署到子路径时（GitHub Pages 的 /Shop-mind-/），写死 "/logo.png" 会 404，
 * 因此必须拼上 import.meta.env.BASE_URL。
 */
function assetUrl(path: string): string {
  return `${import.meta.env.BASE_URL}${path}`;
}

const statusLabels: Record<string, string> = {
  draft: '草稿',
  active: '当前生效',
  archived: '历史版本',
  failed: '处理失败',
  UNSTART: '等待解析',
  RUNNING: '解析中',
  DONE: '已完成',
  FAIL: '解析失败',
  CANCEL: '已取消',
};

function formatDate(value?: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '操作失败，请稍后重试';
}

function formatReadableText(value?: string | null) {
  if (!value) return '';
  const lines: string[] = [];
  const text = value.replace(/\r\n?/g, '\n').replace(/[；;]/g, '\n').replace(/```(?:[\w+-]+)?\s*/g, '').replace(/```/g, '');
  for (const raw of text.split('\n')) {
    let line = raw.trim();
    if (!line) {
      if (lines.length && lines[lines.length - 1] !== '') lines.push('');
      continue;
    }
    if (line.includes('|')) {
      const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
      if (cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
      if (cells.length > 1) {
        cells.filter(Boolean).forEach((cell) => {
          const cleaned = cell.replace(/^#{1,6}\s*/, '').replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, '')
            .replace(/(\*\*|__|~~|`)/g, '').replace(/\s+/g, ' ').trim();
          if (cleaned) lines.push(cleaned);
        });
        continue;
      }
    }
    if (/^[-_*]{3,}$/.test(line)) continue;
    line = line.replace(/^#{1,6}\s*/, '').replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, '');
    line = line.replace(/(\*\*|__|~~|`)/g, '').replace(/\s+/g, ' ').trim();
    if (line) lines.push(line);
  }
  while (lines.at(-1) === '') lines.pop();
  return lines.join('\n');
}

function LoadingScreen() {
  return (
    <div className="loading-screen">
      <img src={assetUrl('logo.png')} alt="ShopMind" />
      <LoaderCircle className="spin" size={22} />
    </div>
  );
}

function EmptyState({ icon, title, description, action }: { icon: ReactNode; title: string; description: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <strong>{title}</strong>
      <p>{description}</p>
      {action}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`status status-${status.toLowerCase()}`}>{statusLabels[status] || status}</span>;
}

function Toast({ message, kind = 'error', onClose }: { message: string; kind?: 'error' | 'success'; onClose: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onClose, 4500);
    return () => window.clearTimeout(timer);
  }, [onClose]);
  return (
    <div className={`toast toast-${kind}`}>
      {kind === 'success' ? <Check size={18} /> : <CircleAlert size={18} />}
      <span>{message}</span>
      <button onClick={onClose} aria-label="关闭提示"><X size={16} /></button>
    </div>
  );
}

function LoginPage({ onLogin }: { onLogin: (user: User) => void }) {
  const [username, setUsername] = useState(() => localStorage.getItem('shopmind-remembered-username') || '');
  // 演示构建下预填演示密码，访客点一下登录即可体验；真实环境保持空白。
  const [password, setPassword] = useState(() => (DEMO_MODE ? DEMO_CREDENTIALS.password : ''));
  const [showPassword, setShowPassword] = useState(false);
  const [rememberUsername, setRememberUsername] = useState(() => Boolean(localStorage.getItem('shopmind-remembered-username')));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [helpMessage, setHelpMessage] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    const normalizedUsername = username.trim();
    if (!normalizedUsername || !password) {
      setError('请输入账号和密码');
      return;
    }
    setLoading(true);
    setError('');
    setHelpMessage('');
    try {
      const result = await api.login(normalizedUsername, password);
      if (rememberUsername) {
        localStorage.setItem('shopmind-remembered-username', normalizedUsername);
      } else {
        localStorage.removeItem('shopmind-remembered-username');
      }
      onLogin(result.user);
    } catch (requestError) {
      if (requestError instanceof ApiError) {
        setError(requestError.status >= 500
          ? '登录服务暂时不可用，请稍后重试'
          : '账号或密码错误，请检查后重试');
      } else {
        setError('网络连接异常，请稍后重试');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-glow login-glow-one" />
      <div className="login-glow login-glow-two" />
      <section className="login-story">
        <div className="brand-lockup">
          <img src={assetUrl('logo.png')} alt="ShopMind" />
          <span>ShopMind</span>
        </div>
        <div className="login-copy">
          <span className="eyebrow"><Sparkles size={15} /> 企业知识驱动的客服工作台</span>
          <h1>让每一次回复，<br />都有规则依据</h1>
          <p>统一检索企业规则、活动政策和售后知识，为客服提供稳定、可追溯的回答建议。</p>
        </div>
        <div className="login-points">
          <span><ShieldCheck size={18} /> 内部部署与权限隔离</span>
          <span><BookOpen size={18} /> 知识版本随时发布回滚</span>
          <span><Bot size={18} /> AI 辅助客服回复建议</span>
        </div>
      </section>
      <section className="login-panel-wrap">
        <form className="login-panel" onSubmit={submit}>
          <div className="login-panel-header">
            <p className="eyebrow plain">企业内部工作台</p>
            <h2>欢迎回来</h2>
            <p className="muted">使用企业账号登录 ShopMind 工作台</p>
          </div>
          {DEMO_MODE && (
            <p className="demo-login-note">
              这是在线演示版：账号与密码已预填，直接点击登录即可体验知识库管理、文档解析状态与智能问答。
              所有数据在浏览器本地生成，不会调用 RAGFlow 或任何模型服务。
            </p>
          )}
          <label className="login-field">
            <span>账号</span>
            <input
              value={username}
              onChange={(event) => { setUsername(event.target.value); setError(''); }}
              autoComplete="username"
              placeholder="请输入企业账号"
              required
            />
          </label>
          <label className="login-field">
            <span>密码</span>
            <span className="password-field">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(event) => { setPassword(event.target.value); setError(''); }}
                autoComplete="current-password"
                placeholder="请输入密码"
                required
              />
              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowPassword((value) => !value)}
                aria-label={showPassword ? '隐藏密码' : '显示密码'}
                title={showPassword ? '隐藏密码' : '显示密码'}
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </span>
          </label>
          <div className="login-options">
            <label className="checkbox-label">
              <input type="checkbox" checked={rememberUsername} onChange={(event) => setRememberUsername(event.target.checked)} />
              <span>记住账号</span>
            </label>
            <button type="button" className="text-button login-link" onClick={() => setHelpMessage('如需重置密码，请联系企业管理员或 IT 支持。')}>
              忘记密码？
            </button>
          </div>
          <div className={`form-error ${error ? 'is-visible' : ''}`} role="alert" aria-live="polite" aria-hidden={!error}>
            <CircleAlert size={17} />
            <span>{error || ' '}</span>
          </div>
          <button type="submit" className="button primary large" disabled={loading} aria-busy={loading}>
            {loading ? <><LoaderCircle className="spin" size={18} /> 正在验证…</> : <>进入工作台 <ArrowRight size={18} /></>}
          </button>
          <div className="login-support">
            <div className="login-support-copy">
              <strong>需要帮助？</strong>
              <span>{helpMessage || '首次使用请联系企业管理员申请账号'}</span>
            </div>
            <button type="button" className="text-button login-link" onClick={() => setHelpMessage('请联系企业管理员申请账号、重置密码或确认访问权限。')}>
              联系管理员
            </button>
          </div>
          <p className="login-note">仅限企业内部授权人员使用 · 登录信息将受到安全保护</p>
        </form>
      </section>
    </div>
  );
}

const navigation = [
  { to: '/dashboard', label: '工作台总览', icon: LayoutDashboard },
  { to: '/assistant', label: '智能问答', icon: MessageSquareText },
  { to: '/knowledge', label: '知识中心', icon: BookOpen },
  { to: '/settings', label: '系统设置', icon: Settings },
];

function AppShell({ user, theme, onTheme, onLogout }: { user: User; theme: Theme; onTheme: () => void; onLogout: () => void }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMobileOpen(false), [location.pathname]);
  const current = navigation.find((item) => location.pathname.startsWith(item.to));

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}>
        <div className="sidebar-brand">
          <img src={assetUrl('logo.png')} alt="ShopMind" />
          <div><strong>ShopMind</strong><span>企业智能客服</span></div>
        </div>
        <nav>
          <p className="nav-label">工作空间</p>
          {navigation.map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
              <item.icon size={19} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="user-card">
            <span className="avatar">{user.display_name.slice(0, 1)}</span>
            <div><strong>{user.display_name}</strong><span>{user.role === 'admin' ? '系统管理员' : '客服专员'}</span></div>
          </div>
          <button className="icon-button" onClick={onLogout} title="退出登录"><LogOut size={18} /></button>
        </div>
      </aside>
      {mobileOpen && <button className="sidebar-backdrop" onClick={() => setMobileOpen(false)} aria-label="关闭菜单" />}
      <main className="main-area">
        <header className="topbar">
          <div className="topbar-title">
            <button className="icon-button mobile-menu" onClick={() => setMobileOpen(true)}><Menu size={20} /></button>
            <div><span>ShopMind</span><strong>{current?.label || '工作台'}</strong></div>
          </div>
          <div className="topbar-actions">
            <DemoBadge />
            <span className="system-chip"><span className="online-dot" /> 企业知识服务</span>
            <button className="icon-button" onClick={onTheme} title={theme === 'light' ? '切换深色模式' : '切换浅色模式'}>
              {theme === 'light' ? <Moon size={19} /> : <Sun size={19} />}
            </button>
          </div>
        </header>
        <div className={`page-area ${location.pathname === '/assistant' ? 'page-area-assistant' : ''}`}>
          <Routes>
            <Route path="/dashboard" element={<DashboardPage user={user} />} />
            <Route path="/assistant" element={<AssistantPage />} />
            <Route path="/knowledge" element={<KnowledgePage />} />
            <Route path="/knowledge/:knowledgeBaseId" element={<KnowledgeDetailPage />} />
            <Route path="/settings" element={<SettingsPage user={user} />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}

function DashboardPage({ user }: { user: User }) {
  const [data, setData] = useState<{ metrics: Record<string, number>; knowledge_bases: KnowledgeBase[] } | null>(null);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  useEffect(() => { api.dashboard().then(setData).catch((value) => setError(errorMessage(value))); }, []);

  if (!data && !error) return <LoadingScreen />;
  const metrics = data?.metrics || {};
  const metricCards: Array<{ label: string; value: number; Icon: LucideIcon; description: string }> = [
    { label: '知识库', value: metrics.knowledge_bases || 0, Icon: BookOpen, description: '统一管理企业规则' },
    { label: '生效版本', value: metrics.active_versions || 0, Icon: ShieldCheck, description: '当前可用于回答' },
    { label: '规则文档', value: metrics.documents || 0, Icon: FileText, description: '已接入的企业资料' },
    { label: '客服会话', value: metrics.conversations || 0, Icon: MessageSquareText, description: '历史问答会话' },
  ];
  return (
    <div className="page-stack">
      <section className="hero-card">
        <div>
          <p className="eyebrow plain">工作台总览</p>
          <h1>早上好，{user.display_name}</h1>
          <p>企业知识服务运行概况，以及今天需要关注的知识工作。</p>
        </div>
        <button className="button primary" onClick={() => navigate('/assistant')}><Sparkles size={18} /> 开始智能问答</button>
      </section>
      {error && <div className="alert error"><CircleAlert size={18} /> {error}</div>}
      <section className="metric-grid">
        {metricCards.map(({ label, value, Icon, description }) => (
          <article className="metric-card" key={label}>
            <div className="metric-icon"><Icon size={21} /></div>
            <strong>{String(value).padStart(2, '0')}</strong>
            <span>{label}</span>
            <p>{description}</p>
          </article>
        ))}
      </section>
      <section className="dashboard-grid">
        <article className="panel">
          <div className="panel-heading"><div><span>知识状态</span><h2>最近知识库</h2></div><button className="text-button" onClick={() => navigate('/knowledge')}>查看全部 <ChevronRight size={16} /></button></div>
          {data?.knowledge_bases.length ? (
            <div className="compact-list">
              {data.knowledge_bases.map((kb) => (
                <button key={kb.id} className="compact-row" onClick={() => navigate(`/knowledge/${kb.id}`)}>
                  <span className="file-icon"><BookOpen size={18} /></span>
                  <span className="grow"><strong>{kb.name}</strong><small>{kb.description || '暂无说明'}</small></span>
                  {kb.active_version_id ? <StatusBadge status="active" /> : <StatusBadge status="draft" />}
                  <ChevronRight size={17} />
                </button>
              ))}
            </div>
          ) : <EmptyState icon={<BookOpen size={25} />} title="还没有知识库" description="创建第一个企业规则知识库后，即可开始构建问答服务。" />}
        </article>
        <article className="panel insight-panel">
          <div className="panel-heading"><div><span>使用建议</span><h2>让答案更可靠</h2></div></div>
          <div className="insight-list">
            <div><span>01</span><p><strong>先发布，再问答</strong><small>只有完成解析并发布的版本会参与客服问答。</small></p></div>
            <div><span>02</span><p><strong>保留清晰标题</strong><small>规则名称、适用范围和生效日期能提升检索可解释性。</small></p></div>
            <div><span>03</span><p><strong>依据优先</strong><small>没有检索依据时，系统将建议转交人工确认。</small></p></div>
          </div>
        </article>
      </section>
    </div>
  );
}

function AssistantPage() {
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [showKnowledgePicker, setShowKnowledgePicker] = useState(false);
  const [selectedKnowledgeBaseIds, setSelectedKnowledgeBaseIds] = useState<string[]>([]);
  const [deletingConversationId, setDeletingConversationId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const messageRequestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const [kbResult, conversationResult] = await Promise.all([api.knowledgeBases(), api.conversations()]);
    setKnowledgeBases(kbResult.items.filter((item) => item.active_version_id));
    setConversations(conversationResult.items);
    return conversationResult.items;
  }, []);

  useEffect(() => { refresh().catch((value) => setError(errorMessage(value))); }, [refresh]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, sending]);

  async function selectConversation(conversation: Conversation) {
    const requestId = ++messageRequestIdRef.current;
    setActiveConversation(conversation);
    setError('');
    try {
      const result = await api.messages(conversation.id);
      if (requestId === messageRequestIdRef.current) setMessages(result.items);
    } catch (requestError) {
      if (requestId === messageRequestIdRef.current) setError(errorMessage(requestError));
    }
  }

  function openNewConversation() {
    if (!knowledgeBases.length) {
      setError('请先在知识中心发布至少一个知识库版本');
      return;
    }
    setSelectedKnowledgeBaseIds((current) => current.length ? current : [knowledgeBases[0].id]);
    setShowKnowledgePicker(true);
    setError('');
  }

  async function newConversation() {
    if (!selectedKnowledgeBaseIds.length) {
      setError('请至少选择一个知识库');
      return;
    }
    try {
      const created = await api.createConversation(selectedKnowledgeBaseIds, '新客服咨询');
      const item = {
        ...created,
        knowledge_base_name: created.knowledge_base_name || knowledgeBases.filter((kb) => selectedKnowledgeBaseIds.includes(kb.id)).map((kb) => kb.name).join('、'),
      };
      setConversations((current) => [item, ...current]);
      ++messageRequestIdRef.current;
      setActiveConversation(item);
      setMessages([]);
      setShowKnowledgePicker(false);
    } catch (requestError) {
      setError(errorMessage(requestError));
    }
  }

  async function removeConversation(event: MouseEvent, conversation: Conversation) {
    event.stopPropagation();
    if (!window.confirm(`确定删除会话“${conversation.title}”吗？`)) return;
    setDeletingConversationId(conversation.id);
    try {
      await api.deleteConversation(conversation.id);
      setConversations((current) => current.filter((item) => item.id !== conversation.id));
      if (activeConversation?.id === conversation.id) {
        ++messageRequestIdRef.current;
        setActiveConversation(null);
        setMessages([]);
      }
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setDeletingConversationId(null);
    }
  }

  const visibleConversations = useMemo(() => {
    const keyword = searchTerm.trim().toLowerCase();
    if (!keyword) return conversations;
    return conversations.filter((conversation) => `${conversation.title} ${conversation.knowledge_base_name}`.toLowerCase().includes(keyword));
  }, [conversations, searchTerm]);

  async function send(event: FormEvent) {
    event.preventDefault();
    const content = question.trim();
    if (!content || sending) return;
    let conversation = activeConversation;
    if (!conversation) {
      if (!knowledgeBases.length) {
        setError('请先发布一个知识库版本');
        return;
      }
      try {
        const selectedIds = selectedKnowledgeBaseIds.length ? selectedKnowledgeBaseIds : [knowledgeBases[0].id];
        const created = await api.createConversation(selectedIds, content.slice(0, 30));
        conversation = {
          ...created,
          knowledge_base_name: created.knowledge_base_name || knowledgeBases.filter((kb) => selectedIds.includes(kb.id)).map((kb) => kb.name).join('、'),
        };
        ++messageRequestIdRef.current;
        setActiveConversation(conversation);
        setConversations((current) => [conversation!, ...current]);
        setShowKnowledgePicker(false);
      } catch (requestError) {
        setError(errorMessage(requestError));
        return;
      }
    }
    const optimistic: Message = { id: `temp-${Date.now()}`, role: 'user', content, references: [], created_at: new Date().toISOString() };
    setMessages((current) => [...current, optimistic]);
    setQuestion('');
    setSending(true);
    setError('');
    try {
      const result = await api.sendMessage(conversation.id, content);
      setMessages((current) => [...current.filter((item) => item.id !== optimistic.id), result.user_message, result.assistant_message]);
      await refresh();
    } catch (requestError) {
      setMessages((current) => current.filter((item) => item.id !== optimistic.id));
      setQuestion(content);
      setError(errorMessage(requestError));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="assistant-layout">
      <aside className="conversation-panel">
        <div className="conversation-heading">
          <div><span>客服会话</span><strong>{conversations.length} 个会话</strong></div>
          <button className="icon-button accent" onClick={openNewConversation} title="新建会话"><Plus size={18} /></button>
        </div>
        <div className="search-box"><Search size={16} /><input value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="搜索会话" /></div>
        {showKnowledgePicker && (
          <div className="knowledge-picker">
            <div className="knowledge-picker-title">
              <div>
                <strong>选择参考知识库</strong>
                <small>已选择 {selectedKnowledgeBaseIds.length} 个</small>
              </div>
              <button type="button" onClick={() => setShowKnowledgePicker(false)} aria-label="关闭"><X size={15} /></button>
            </div>
            <p>可同时选择多个已发布知识库，回答会综合所选内容</p>
            <div className="knowledge-picker-options">
              {knowledgeBases.map((kb) => (
                <label key={kb.id} className={`knowledge-option ${selectedKnowledgeBaseIds.includes(kb.id) ? 'selected' : ''}`} title={kb.name}>
                  <input type="checkbox" checked={selectedKnowledgeBaseIds.includes(kb.id)} onChange={() => setSelectedKnowledgeBaseIds((current) => current.includes(kb.id) ? current.filter((id) => id !== kb.id) : [...current, kb.id])} />
                  <span>{kb.name}</span>
                </label>
              ))}
            </div>
            <button className="picker-confirm" type="button" onClick={newConversation} disabled={!selectedKnowledgeBaseIds.length}>开始会话</button>
          </div>
        )}
        <div className="conversation-list">
          {visibleConversations.map((conversation) => (
            <div key={conversation.id} className={`conversation-item ${activeConversation?.id === conversation.id ? 'active' : ''}`} onClick={() => selectConversation(conversation)} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') selectConversation(conversation); }}>
              <span className="conversation-icon"><MessageSquareText size={17} /></span>
              <span className="conversation-main"><strong>{conversation.title}</strong><small>{conversation.knowledge_base_name} · {formatDate(conversation.updated_at)}</small></span>
              <button className="conversation-delete" type="button" title="删除会话" disabled={deletingConversationId === conversation.id} onClick={(event) => removeConversation(event, conversation)}><Trash2 size={14} /></button>
            </div>
          ))}
          {!visibleConversations.length && <p className="list-placeholder">{conversations.length ? '没有匹配的会话' : '暂无历史会话'}</p>}
        </div>
      </aside>
      <section className="chat-workspace">
        <header className="chat-header">
          <div>
            <span className="assistant-avatar"><Bot size={21} /></span>
            <div><strong>{activeConversation?.title || 'ShopMind 智能客服'}</strong><small><span className="online-dot" /> 知识依据优先 · 无依据不编造</small></div>
          </div>
          {activeConversation && <span className="knowledge-chip"><BookOpen size={15} /> {activeConversation.knowledge_base_name}</span>}
        </header>
        <div className="messages-area">
          {!messages.length ? (
            <div className="chat-welcome">
              <span className="welcome-orbit"><Sparkles size={25} /></span>
              <h1>今天需要查什么规则？</h1>
              <p>我会从已发布的企业知识库中检索依据，并生成可直接参考的客服回复。</p>
              <div className="suggestion-grid">
                {['活动优惠能否与会员券叠加？', '商品拆封后是否支持退货？', '预售商品什么时候可以发货？'].map((text) => (
                  <button key={text} onClick={() => setQuestion(text)}>{text}<ArrowRight size={16} /></button>
                ))}
              </div>
            </div>
          ) : (
            <div className="message-stream">
              {messages.map((message) => (
                <article key={message.id} className={`message ${message.role}`}>
                  <span className="message-avatar">{message.role === 'assistant' ? <Bot size={18} /> : '我'}</span>
                  <div className="message-body">
                    <div className="message-meta"><strong>{message.role === 'assistant' ? 'ShopMind' : '我'}</strong><span>{formatDate(message.created_at)}</span></div>
                    <div className="message-content">{formatReadableText(message.content) || '当前未生成可展示的回答，请查看下方回答依据。'}</div>
                    {!!message.references?.length && (
                      <div className="reference-list">
                        <p><BookOpen size={15} /> 回答依据 · {message.references.length} 条</p>
                        {message.references.slice(0, 4).map((reference, index) => (
                          <details key={reference.id || `${message.id}-${index}`}>
                            <summary><span>{index + 1}</span>{reference.document_keyword || '企业规则文档'}<ChevronRight size={15} /></summary>
                            <p>{formatReadableText(reference.content) || '已引用该文档中的相关规则片段。'}</p>
                          </details>
                        ))}
                      </div>
                    )}
                  </div>
                </article>
              ))}
              {sending && <article className="message assistant"><span className="message-avatar"><Bot size={18} /></span><div className="thinking"><i /><i /><i /><span>正在检索并组织回答</span></div></article>}
              <div ref={bottomRef} />
            </div>
          )}
        </div>
        <footer className="composer-wrap">
          {error && <div className="composer-error"><CircleAlert size={16} /> {error}</div>}
          <form className="composer" onSubmit={send}>
            <textarea value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
            }} placeholder="输入客户问题，Enter 发送，Shift + Enter 换行" rows={1} />
            <button disabled={!question.trim() || sending} aria-label="发送"><Send size={18} /></button>
          </form>
          <p>回答由企业知识库与所选模型生成，请在发送给客户前核对引用依据。</p>
        </footer>
      </section>
    </div>
  );
}

function KnowledgePage() {
  const [items, setItems] = useState<KnowledgeBase[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ message: string; kind: 'error' | 'success' } | null>(null);
  const navigate = useNavigate();

  const load = useCallback(() => api.knowledgeBases().then((result) => setItems(result.items)).finally(() => setLoading(false)), []);
  useEffect(() => { load().catch((error) => setToast({ message: errorMessage(error), kind: 'error' })); }, [load]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const created = await api.createKnowledgeBase({ name, description });
      setShowCreate(false);
      setName(''); setDescription('');
      navigate(`/knowledge/${created.id}`);
    } catch (error) {
      setToast({ message: errorMessage(error), kind: 'error' });
    } finally { setSaving(false); }
  }

  async function editKnowledgeBase(item: KnowledgeBase) {
    const nextName = window.prompt('知识库名称', item.name)?.trim();
    if (!nextName || nextName === item.name) return;
    const nextDescription = window.prompt('用途说明', item.description || '') ?? item.description;
    setSaving(true);
    try {
      const updated = await api.updateKnowledgeBase(item.id, { name: nextName, description: nextDescription });
      setItems((current) => current.map((value) => value.id === updated.id ? updated : value));
      setToast({ message: '知识库信息已更新', kind: 'success' });
    } catch (error) { setToast({ message: errorMessage(error), kind: 'error' }); }
    finally { setSaving(false); }
  }

  async function removeKnowledgeBase(item: KnowledgeBase) {
    if (!window.confirm(`确认删除“${item.name}”吗？其版本、文档和关联问答记录都会被删除。`)) return;
    setSaving(true);
    try {
      await api.deleteKnowledgeBase(item.id);
      setItems((current) => current.filter((value) => value.id !== item.id));
      setToast({ message: '知识库及其内容已删除', kind: 'success' });
    } catch (error) { setToast({ message: errorMessage(error), kind: 'error' }); }
    finally { setSaving(false); }
  }

  return (
    <div className="page-stack">
      <section className="page-heading">
        <div><p className="eyebrow plain">知识中心</p><h1>企业规则知识库</h1><p>独立构建、校验并发布知识版本，更新过程不会中断现有问答。</p></div>
        <button className="button primary" onClick={() => setShowCreate(true)}><Plus size={18} /> 新建知识库</button>
      </section>
      <div className="toolbar"><div className="search-box wide"><Search size={17} /><input placeholder="搜索知识库名称" /></div><button className="button subtle" onClick={() => load()}><RefreshCw size={17} /> 刷新状态</button></div>
      {loading ? <LoadingScreen /> : items.length ? (
        <section className="knowledge-grid">
            {items.map((kb) => (
            <article className="knowledge-card" key={kb.id} onClick={() => navigate(`/knowledge/${kb.id}`)}>
              <div className="knowledge-card-top"><span className="knowledge-icon"><BookOpen size={22} /></span>{kb.active_version_id ? <StatusBadge status="active" /> : <StatusBadge status="draft" />}</div>
              <h2>{kb.name}</h2><p>{kb.description || '暂无知识库说明'}</p>
              <div className="knowledge-stats"><span><strong>{kb.version_count || 1}</strong> 个版本</span><span><strong>{kb.active_version_number ? `V${kb.active_version_number}` : '—'}</strong> 生效版本</span></div>
              <footer><span>更新于 {formatDate(kb.updated_at)}</span><span className="card-actions">
                <button type="button" className="icon-button" title="编辑知识库" aria-label="编辑知识库" onClick={(event) => { event.stopPropagation(); editKnowledgeBase(kb); }} disabled={saving}><Pencil size={15} /></button>
                <button type="button" className="icon-button danger" title="删除知识库" aria-label="删除知识库" onClick={(event) => { event.stopPropagation(); removeKnowledgeBase(kb); }} disabled={saving}><Trash2 size={15} /></button>
                <ChevronRight size={18} />
              </span></footer>
            </article>
          ))}
        </section>
      ) : <EmptyState icon={<Database size={27} />} title="建立第一份企业知识" description="上传规则文档、等待 RAGFlow 解析并发布后，即可用于智能客服问答。" action={<button className="button primary" onClick={() => setShowCreate(true)}><Plus size={17} /> 新建知识库</button>} />}
      {showCreate && <div className="modal-backdrop"><form className="modal" onSubmit={create}><header><div><span>创建知识库</span><h2>开始管理一类企业规则</h2></div><button type="button" className="icon-button" onClick={() => setShowCreate(false)}><X size={19} /></button></header><label><span>知识库名称</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：售后与退换货规则" required minLength={2} /></label><label><span>用途说明</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="说明知识库适用的业务范围" rows={4} /></label><div className="modal-actions"><button type="button" className="button subtle" onClick={() => setShowCreate(false)}>取消</button><button className="button primary" disabled={saving}>{saving ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />} 创建知识库</button></div></form></div>}
      {toast && <Toast {...toast} onClose={() => setToast(null)} />}
    </div>
  );
}

function KnowledgeDetailPage() {
  const { knowledgeBaseId = '' } = useParams();
  const [kb, setKb] = useState<KnowledgeBase | null>(null);
  const [versions, setVersions] = useState<KnowledgeVersion[]>([]);
  const [selected, setSelected] = useState<KnowledgeVersion | null>(null);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState<{ message: string; kind: 'error' | 'success' } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadVersions = useCallback(async () => {
    const [kbResult, versionResult] = await Promise.all([api.knowledgeBases(), api.versions(knowledgeBaseId)]);
    const found = kbResult.items.find((item) => item.id === knowledgeBaseId) || null;
    setKb(found);
    setVersions(versionResult.items);
    setSelected((current) => versionResult.items.find((item) => item.id === current?.id) || versionResult.items[0] || null);
  }, [knowledgeBaseId]);

  useEffect(() => { loadVersions().catch((error) => setToast({ message: errorMessage(error), kind: 'error' })); }, [loadVersions]);
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    let timer: number | undefined;
    const loadDocuments = async () => {
      try {
        const result = await api.documents(knowledgeBaseId, selected.id);
        if (cancelled) return;
        setDocuments(result.items);
        const hasPending = result.items.some((item) => !['DONE', '3', 'FAIL', 'failed'].includes(String(item.status)));
        if (hasPending) timer = window.setTimeout(loadDocuments, 2500);
      } catch (error) {
        if (!cancelled) setToast({ message: errorMessage(error), kind: 'error' });
      }
    };
    void loadDocuments();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [knowledgeBaseId, selected?.id]);

  async function createVersion() {
    setBusy('version');
    try {
      await api.createVersion(knowledgeBaseId);
      await loadVersions();
      setToast({ message: '新的草稿版本已创建', kind: 'success' });
    } catch (error) { setToast({ message: errorMessage(error), kind: 'error' }); }
    finally { setBusy(''); }
  }

  async function upload(file?: File) {
    if (!file || !selected) return;
    setBusy('upload');
    try {
      await api.uploadDocument(knowledgeBaseId, selected.id, file);
      setDocuments((await api.documents(knowledgeBaseId, selected.id)).items);
      setToast({ message: '文件已提交 RAGFlow 解析', kind: 'success' });
    } catch (error) { setToast({ message: errorMessage(error), kind: 'error' }); }
    finally { setBusy(''); if (fileRef.current) fileRef.current.value = ''; }
  }

  async function publish() {
    if (!selected) return;
    setBusy('publish');
    try {
      await api.publishVersion(knowledgeBaseId, selected.id);
      await loadVersions();
      setToast({ message: `V${selected.version_number} 已原子切换为生效版本`, kind: 'success' });
    } catch (error) { setToast({ message: errorMessage(error), kind: 'error' }); }
    finally { setBusy(''); }
  }

  async function editVersion(version: KnowledgeVersion) {
    if (version.status === 'active') return;
    const name = window.prompt('版本名称', version.name || `V${version.version_number}`)?.trim();
    if (!name || name === version.name) return;
    setBusy('version-edit');
    try {
      await api.updateVersion(knowledgeBaseId, version.id, name);
      await loadVersions();
      setToast({ message: '版本名称已更新', kind: 'success' });
    } catch (error) { setToast({ message: errorMessage(error), kind: 'error' }); }
    finally { setBusy(''); }
  }

  async function removeVersion(version: KnowledgeVersion) {
    if (version.status === 'active') return;
    if (!window.confirm(`确认删除 V${version.version_number} 吗？版本内的文档也会被删除。`)) return;
    setBusy('version-delete');
    try {
      await api.deleteVersion(knowledgeBaseId, version.id);
      await loadVersions();
      setToast({ message: '版本已删除', kind: 'success' });
    } catch (error) { setToast({ message: errorMessage(error), kind: 'error' }); }
    finally { setBusy(''); }
  }

  async function editDocument(document: KnowledgeDocument) {
    if (!selected || selected.status === 'active') return;
    const name = window.prompt('文档名称', document.name)?.trim();
    if (!name || name === document.name) return;
    setBusy('document-edit');
    try {
      await api.updateDocument(knowledgeBaseId, selected.id, document.id, name);
      setDocuments((current) => current.map((item) => item.id === document.id ? { ...item, name } : item));
      setToast({ message: '文档名称已更新', kind: 'success' });
    } catch (error) { setToast({ message: errorMessage(error), kind: 'error' }); }
    finally { setBusy(''); }
  }

  async function removeDocument(document: KnowledgeDocument) {
    if (!selected || selected.status === 'active') return;
    if (!window.confirm(`确认删除文档“${document.name}”吗？`)) return;
    setBusy('document-delete');
    try {
      await api.deleteDocument(knowledgeBaseId, selected.id, document.id);
      setDocuments((current) => current.filter((item) => item.id !== document.id));
      await loadVersions();
      setToast({ message: '文档已删除', kind: 'success' });
    } catch (error) { setToast({ message: errorMessage(error), kind: 'error' }); }
    finally { setBusy(''); }
  }

  if (!kb || !selected) return <LoadingScreen />;
  const canPublish = selected.status !== 'active' && documents.length > 0 && documents.every((item) => item.status === 'DONE' || item.status === '3');
  return (
    <div className="page-stack">
      <section className="page-heading compact"><div><p className="eyebrow plain">知识中心 / {kb.name}</p><h1>{kb.name}</h1><p>{kb.description || '暂无知识库说明'}</p></div><div className="heading-actions"><button className="button subtle" onClick={createVersion} disabled={!!busy}><Plus size={17} /> 新建草稿版本</button><button className="button primary" onClick={publish} disabled={!canPublish || !!busy}>{busy === 'publish' ? <LoaderCircle className="spin" size={17} /> : <ShieldCheck size={17} />} 发布当前版本</button></div></section>
      <section className="knowledge-detail-grid">
        <aside className="version-panel panel">
          <div className="panel-heading"><div><span>版本记录</span><h2>{versions.length} 个版本</h2></div></div>
          <div className="version-list">
            {versions.map((version) => <div key={version.id} className={`version-item ${selected.id === version.id ? 'active' : ''}`}><button className="version-select" onClick={() => setSelected(version)}><span className="version-badge">V{version.version_number}</span><span><strong>{version.name || statusLabels[version.status]}</strong><small>{version.document_count} 份文档 · {formatDate(version.created_at)}</small></span><StatusBadge status={version.status} /></button>{version.status !== 'active' && <span className="row-actions"><button type="button" className="icon-button" title="编辑版本" onClick={() => editVersion(version)} disabled={!!busy}><Pencil size={14} /></button><button type="button" className="icon-button danger" title="删除版本" onClick={() => removeVersion(version)} disabled={!!busy}><Trash2 size={14} /></button></span>}</div>)}
          </div>
          <div className="zero-downtime-note"><ShieldCheck size={18} /><p><strong>无中断发布</strong><span>草稿解析完成后才切换生效指针，旧版本在此期间继续回答。</span></p></div>
        </aside>
        <article className="document-panel panel">
          <div className="panel-heading document-heading"><div><span>V{selected.version_number} · {statusLabels[selected.status]}</span><h2>规则文档</h2></div><div><input ref={fileRef} type="file" hidden accept=".pdf,.doc,.docx,.html,.htm,.md,.txt,.csv,.xls,.xlsx" onChange={(event) => upload(event.target.files?.[0])} /><button className="button primary" onClick={() => fileRef.current?.click()} disabled={selected.status === 'active' || !!busy}>{busy === 'upload' ? <LoaderCircle className="spin" size={17} /> : <Upload size={17} />} 上传文档</button></div></div>
          <div className="document-types"><span>支持 PDF</span><span>Word</span><span>HTML</span><span>Markdown</span><span>Excel / CSV</span><small>单文件最大 64 MB</small></div>
          {documents.length ? <div className="document-table"><div className="table-head"><span>文件名称</span><span>大小</span><span>处理状态</span><span>上传时间</span><span>操作</span></div>{documents.map((document) => <div className="table-row" key={document.id}><span className="document-name"><FileText size={18} /><span><strong>{document.name}</strong>{document.error_message && <small>{document.error_message}</small>}</span></span><span>{formatBytes(document.size)}</span><span><StatusBadge status={document.status} /></span><span>{formatDate(document.created_at)}</span><span className="row-actions">{selected.status !== 'active' && <><button type="button" className="icon-button" title="编辑文档名称" onClick={() => editDocument(document)} disabled={!!busy}><Pencil size={14} /></button><button type="button" className="icon-button danger" title="删除文档" onClick={() => removeDocument(document)} disabled={!!busy}><Trash2 size={14} /></button></>}</span></div>)}</div> : <EmptyState icon={<Upload size={26} />} title="当前版本还没有文档" description={selected.status === 'active' ? '该版本没有关联文档。' : '上传企业规则文件，文档处理将由 RAGFlow 内部服务完成。'} action={selected.status !== 'active' ? <button className="button subtle" onClick={() => fileRef.current?.click()}><Upload size={17} /> 选择文件</button> : undefined} />}
        </article>
      </section>
      {toast && <Toast {...toast} onClose={() => setToast(null)} />}
    </div>
  );
}

function SettingsPage({ user }: { user: User }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState('');
  const [config, setConfig] = useState<import('./types').RagflowConfig | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [configMessage, setConfigMessage] = useState('');
  const load = useCallback(() => api.health().then(setHealth).catch((value) => setError(errorMessage(value))), []);
  const loadConfig = useCallback(() => api.ragflowConfig().then(setConfig).catch((value) => setConfigMessage(errorMessage(value))), []);
  useEffect(() => { load(); if (user.role === 'admin') loadConfig(); }, [load, loadConfig, user.role]);
  async function saveApiKey(event: FormEvent) {
    event.preventDefault();
    const value = apiKey.trim();
    if (!value) { setConfigMessage('请输入 RAGFlow API Key'); return; }
    setSavingKey(true); setConfigMessage('');
    try {
      const result = await api.updateRagflowConfig(value);
      setConfig(result);
      setApiKey('');
      setConfigMessage('API Key 已保存并立即生效，后续请求将使用新密钥。');
      await load();
    } catch (requestError) {
      setConfigMessage(errorMessage(requestError));
    } finally { setSavingKey(false); }
  }
  return (
    <div className="page-stack settings-page">
      <section className="page-heading"><div><p className="eyebrow plain">系统设置</p><h1>服务与运行状态</h1><p>ShopMind 产品层调用 RAGFlow 内部能力，同时保留其数据库和模型提供商扩展能力。</p></div><button className="button subtle" onClick={load}><RefreshCw size={17} /> 重新检测</button></section>
      {error && <div className="alert error"><CircleAlert size={18} /> {error}</div>}
      <section className="settings-grid">
        <article className="panel service-card"><div className="service-title"><span className="metric-icon"><Gauge size={21} /></span><div><h2>ShopMind 产品服务</h2><p>认证、权限、会话与知识版本管理</p></div><StatusBadge status="active" /></div><dl><div><dt>运行状态</dt><dd>正常</dd></div><div><dt>部署范围</dt><dd>单企业内部</dd></div><div><dt>登录方式</dt><dd>账号密码</dd></div></dl></article>
        <article className="panel service-card"><div className="service-title"><span className="metric-icon"><Database size={21} /></span><div><h2>Redis 会话缓存</h2><p>独立 DB 与 shopmind: 键前缀</p></div>{health && <StatusBadge status={health.redis === 'ok' ? 'active' : 'failed'} />}</div><dl><div><dt>用途</dt><dd>会话、上下文、权限缓存</dd></div><div><dt>持久数据</dt><dd>不存储</dd></div><div><dt>当前状态</dt><dd>{health?.redis || '检测中'}</dd></div></dl></article>
        <article className="panel service-card"><div className="service-title"><span className="metric-icon"><Bot size={21} /></span><div><h2>RAGFlow 内部服务</h2><p>解析、索引、检索、重排与模型管理</p></div>{health && <StatusBadge status={health.ragflow.reachable ? 'active' : 'failed'} />}</div><dl><div><dt>连接状态</dt><dd>{health?.ragflow.reachable ? '可用' : '不可用'}</dd></div><div><dt>模型策略</dt><dd>RAGFlow 统一管理</dd></div><div><dt>默认模型</dt><dd>当前配置为 Ollama</dd></div></dl></article>
      </section>
      {health && !health.ragflow_configured && <div className="alert warning"><CircleAlert size={18} /><span>RAGFlow 服务已连通，但尚未配置 ShopMind 使用的 RAGFlow API Key。管理员可在下方直接配置。</span></div>}
      {user.role === 'admin' && <section className="panel api-key-panel">
        <div className="api-key-heading"><span className="metric-icon"><KeyRound size={21} /></span><div><p className="eyebrow plain">连接凭证</p><h2>RAGFlow 内部 API Key</h2><p>填写以 RAGFlow 开头的内部密钥。密钥只在服务端保存，不会回显完整内容，也不会写入日志。</p></div><span className={`status ${config?.configured ? 'status-active' : 'status-draft'}`}>{config?.configured ? '已配置' : '未配置'}</span></div>
        <form className="api-key-form" onSubmit={saveApiKey}>
          <label><span>API Key</span><input type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setConfigMessage(''); }} placeholder="RAGFlow..." autoComplete="new-password" spellCheck={false} /></label>
          <button className="button primary" disabled={savingKey || !apiKey.trim()}>{savingKey ? <><LoaderCircle className="spin" size={17} /> 保存中</> : <><KeyRound size={17} /> 保存并立即生效</>}</button>
        </form>
        <div className="api-key-meta"><span>当前状态：{config?.masked_key || '未配置'}</span><span>{config?.env_file_available === false ? '环境文件未挂载' : '已同步部署环境配置'}</span></div>
        {configMessage && <p className={`api-key-message ${configMessage.includes('失败') || configMessage.includes('请输入') || configMessage.includes('找不到') ? 'is-error' : ''}`} role="status">{configMessage}</p>}
      </section>}
      <section className="panel architecture-panel"><div className="panel-heading"><div><span>能力边界</span><h2>产品层与底层服务</h2></div></div><div className="architecture-flow"><div><span>ShopMind Web</span><small>全新产品界面</small></div><ArrowRight size={20} /><div><span>Product API</span><small>权限与业务封装</small></div><ArrowRight size={20} /><div><span>RAGFlow</span><small>RAG 核心能力</small></div><ArrowRight size={20} /><div><span>模型与数据库</span><small>可配置连接</small></div></div></section>
      <section className="panel ops-panel"><div><span className="metric-icon muted-icon"><Settings size={21} /></span><div><h2>内部运维入口</h2><p>旧 RAGFlow 管理页面仅供本机运维人员管理底层模型、文档引擎和高级参数，不作为 ShopMind 产品界面。</p></div></div><a className="button subtle" href={health?.ops_url || 'http://127.0.0.1:8081'} target="_blank" rel="noreferrer">打开运维页面 <ArrowRight size={17} /></a></section>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('shopmind-theme') as Theme) || 'light');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('shopmind-theme', theme);
  }, [theme]);
  useEffect(() => { api.me().then((result) => setUser(result.user)).catch(() => setUser(null)).finally(() => setChecking(false)); }, []);

  async function logout() {
    try { await api.logout(); } finally { setUser(null); }
  }

  if (checking) return <LoadingScreen />;
  if (!user) return <LoginPage onLogin={setUser} />;
  return <AppShell user={user} theme={theme} onTheme={() => setTheme((value) => value === 'light' ? 'dark' : 'light')} onLogout={logout} />;
}
