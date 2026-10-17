// Vite 配置：演示页打包（demo/index.html 为入口，引用仓库根下 src/ 与 theme/）
// 构建：vite build → dist/（自包含，可直接部署 GitHub Pages）
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: 'demo',
  base: '/AetherMarkdown/', // GitHub 项目页部署路径
  build: { outDir: '../dist', emptyOutDir: true },
  server: { fs: { allow: [repoRoot] } }, // dev server 允许读取根下 src/ 与 theme/
});
