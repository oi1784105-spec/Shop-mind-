import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { installDemo } from './demo';
import './styles.css';

// 演示构建必须在渲染前安装网络垫片：挂载时就会立即请求 /auth/me。
installDemo();

// BrowserRouter 必须带上 basename：部署到 GitHub Pages 子路径时，
// 站内链接与重定向才会留在 /<repo>/ 之内，否则会跳到站点根目录。
const basename = import.meta.env.BASE_URL.replace(/\/$/, '');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter basename={basename}>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
