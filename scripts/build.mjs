// 构建 dsh 可加载的运行时产物：把 src/ 打成单文件 ESM 到 dist/index.js。
// 运行时依赖（@deepseek-ai/*）保持 external——安装进 profile 时由 pnpm 按
// package.json dependencies 落盘解析，避免与宿主出现两套框架实例。
import { build } from 'esbuild'

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['@deepseek-ai/*'],
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
})
