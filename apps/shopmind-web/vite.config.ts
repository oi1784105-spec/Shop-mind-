import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // 这里用 '.' 而不是 process.cwd()：本项目未安装 @types/node，
  // 直接引用 process 会让 tsconfig.node.json 下的类型检查失败。
  // loadEnv 会把它解析为当前工作目录，效果与 process.cwd() 一致。
  const env = loadEnv(mode, '.', '');

  return {
    // GitHub Pages 部署在 /<repo>/ 子路径下（本仓库为 /Shop-mind-/），
    // 需要显式指定 base；本地开发与常规服务器部署保持默认的 '/'。
    base: env.VITE_BASE || '/',
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': env.VITE_API_TARGET || 'http://127.0.0.1:8000',
      },
    },
  };
});
