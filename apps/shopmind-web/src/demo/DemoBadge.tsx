import { DEMO_MODE, resetDemo } from './index';
import './demo.css';

/**
 * 顶栏内联的演示标记。
 *
 * 刻意做成内联元素而不是固定在角落的浮层：这个应用的输入区与侧栏都铺到视口底部，
 * 底部浮层必然压住可交互元素（另外两个项目都踩过这个坑）。
 * 顶栏在登录页与工作台都会渲染，放在这里既显眼又不占用任何内容空间。
 */
export function DemoBadge() {
  if (!DEMO_MODE) return null;

  return (
    <span
      className="demo-badge"
      title="数据由浏览器本地生成，不会调用 RAGFlow、模型或任何后端服务"
    >
      <span className="demo-badge-dot" />
      <span className="demo-badge-text">演示模式</span>
      <button type="button" className="demo-badge-reset" onClick={resetDemo}>
        重置
      </button>
    </span>
  );
}
