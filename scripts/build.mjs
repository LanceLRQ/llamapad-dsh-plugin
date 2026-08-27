// 构建 dsh 可加载的运行时产物：把 src/ 打成单文件 ESM，两个插件入口各出一份。
// - src/index.ts  → dist/index.js（A 形态：LLM 适配器，inject:['llm']）
// - src/tools.ts  → dist/tools.js（B 形态：管理工具，inject:['tools']）
// 运行时依赖（@deepseek-ai/*）保持 external——安装进 profile 时由 pnpm 按
// package.json dependencies 落盘解析，避免与宿主出现两套框架实例。
import { build } from 'esbuild'

await build({
  entryPoints: ['src/index.ts', 'src/tools.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['@deepseek-ai/*'],
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
})
