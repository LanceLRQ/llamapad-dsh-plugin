// 构建 dsh 可加载的运行时产物：把 src/ 打成单文件，三个入口各出一份。
// - src/index.ts         → dist/index.js（A 形态：LLM 适配器，inject:['llm']）
// - src/tools.ts         → dist/tools.js（B 形态：管理工具，inject:['tools']）
// - src/client/index.tsx → dist/client.js（浏览器端设置卡片，exports['./client']）
//
// 前两个是 Node 侧 ESM，运行时依赖（@deepseek-ai/*）保持 external——安装进 profile 时
// 由 pnpm 按 package.json dependencies 落盘解析，避免与宿主出现两套框架实例。
// 第三个是浏览器产物，规则完全不同，见下方 CLIENT 段的注释。
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

/* ===================== CLIENT（浏览器端设置卡片） =====================
 *
 * dsh 的浏览器插件产物格式（逆向自 @deepseek-ai/dsh-client-modules 与官方各
 * dsh-client-ui-* 包的 lib/client.js）：整个 bundle 包在一次
 *
 *   window.__ModuleLoader__.load({ id: "<npm 包全名>", factory: (require) => { … } })
 *
 * 调用里，factory 内部自建 CJS 环境（var module = { exports: {} }）并返回 module.exports。
 * 这里用 esbuild 的 cjs 格式 + banner/footer 拼出同构产物——宿主不校验产物由谁打包。
 *
 * 三条不能碰的红线：
 *
 * 1. 开 minify 前先看清楚代价。RPC 的 wire 字段名已经由 src/rpc-contract.ts 的描述符
 *    写死、不依赖形参名，所以形参改名是安全的；但描述符里的 method 名要能在实例上按
 *    属性取到（网关是 receiver[descriptor.method](...)），一旦哪天开了 mangleProps
 *    之类的属性改名，这条链会在运行期断掉且编译期无感。默认的 minify 不改属性名，
 *    这里仍显式写死 false，保持产物可读、也便于出问题时直接看产物定位。
 *
 * 2. 只有 SEED_MODULES 这 7 个能 external。宿主的模块表是一张硬编码静态种子表
 *    （dsh-web-frontend 的 shell 产物里 `function Jd(){return{react:…}}`），
 *    require 落空是 loud throw，不是静默降级。其余依赖必须真打进产物。
 *
 * 3. 产物缺失 = 整个插件加载失败。package.json 一旦声明 dsh.client，
 *    dsh-client-modules 找不到 exports['./client'] 指向的文件就会抛
 *    MissingClientBundleError 并让该 fiber FAILED——连 LLM 适配器一起挂掉，
 *    不是"卡片不显示"。所以 dist/ 虽不入库，装载前必须先 pnpm run build。
 */

/** 宿主 shell 预置的运行时单例，第三方产物只能 require 这些外部名。 */
const SEED_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

// 必须与 package.json 的 name 逐字一致：宿主按 cordis entry 名（= 包名）注册工厂，
// 对不上会抛 "bundle … loaded without registering …"。
const CLIENT_ID = 'llamapad-dsh-plugin'

await build({
  entryPoints: ['src/client/index.tsx'],
  outfile: 'dist/client.js',
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  jsx: 'automatic',
  external: SEED_MODULES,
  minify: false, // 见上方红线 1
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
  banner: {
    js: [
      'window.__ModuleLoader__.load({',
      `\tid: ${JSON.stringify(CLIENT_ID)},`,
      '\tfactory: (require) => {',
      'var module = { exports: {} };',
      'var exports = module.exports;',
      'Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
    ].join('\n'),
  },
  footer: {
    js: ['return module.exports;', '\t}', '});'].join('\n'),
  },
})
