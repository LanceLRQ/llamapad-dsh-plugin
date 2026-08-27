#!/usr/bin/env node
// 重新打包脚本：插件内容变更后产出新版可安装 tgz。
// 流程：工作区清洁检查 → 质量门禁（typecheck / 单测 / E2E）→ 版本递增 →
// 构建 → pnpm pack → 打印制品 sha256 与安装/更新命令。
// 用法：
//   pnpm run release                    # patch 递增（默认）
//   pnpm run release minor              # minor 递增（0.x 阶段的行为/依赖变更）
//   pnpm run release 0.2.0              # 显式版本
//   pnpm run release --allow-dirty      # 跳过清洁检查（不建议：制品无法溯源到提交）
// 详细说明见 docs/packaging.md。
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

function run(cmd, args, { capture = false } = {}) {
  const r = spawnSync(cmd, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  if (r.status !== 0) {
    console.error(`\n[release] 步骤失败：${cmd} ${args.join(' ')}（退出码 ${r.status ?? r.error}）`)
    process.exit(1)
  }
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

const args = process.argv.slice(2)
const allowDirty = args.includes('--allow-dirty')
const bumpArg = args.find((a) => !a.startsWith('--'))

// 1. 清洁检查：制品的版本号要能对应到提交
if (!allowDirty) {
  const git = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })
  if (git.error) {
    console.warn('[release] 无法执行 git，跳过清洁检查')
  } else if (git.status === 0 && git.stdout.trim()) {
    console.error('[release] 工作区有未提交改动，制品将无法溯源到提交；先提交，或加 --allow-dirty 强制：')
    console.error(git.stdout.trim())
    process.exit(1)
  }
}

// 2. 质量门禁
console.log('[release] 质量门禁：typecheck / 单测 / E2E')
run('pnpm', ['run', 'typecheck'])
run('pnpm', ['test'])
run('pnpm', ['run', 'test:e2e'])

// 3. 版本递增（patch | minor | major | 显式 x.y.z）
function nextVersion(current, arg) {
  if (arg && /^\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?$/.test(arg)) return arg
  const kind = arg ?? 'patch'
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(current)
  if (!m) throw new Error(`无法解析当前版本：${current}`)
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (kind === 'major') return `${a + 1}.0.0`
  if (kind === 'minor') return `${a}.${b + 1}.0`
  if (kind === 'patch') return `${a}.${b}.${c + 1}`
  throw new Error(`无法识别的版本参数：${arg}（可用 patch / minor / major 或显式 x.y.z）`)
}

const pkgPath = resolve(root, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const prev = pkg.version
const next = nextVersion(prev, bumpArg)
pkg.version = next
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)

// pnpm-lock.yaml 不记录根包版本（npm 的 package-lock.json 才需要同步），
// 所以这里只改 package.json，锁文件无需跟着动。
console.log(`[release] 版本：${prev} → ${next}`)

// 4. 构建 + 打包（pack 的 prepare 钩子会再构建一次，幂等）
run('pnpm', ['run', 'build'])
const pack = run('pnpm', ['pack'], { capture: true })
const tgz = [...pack.stdout.split('\n'), ...pack.stderr.split('\n')]
  .map((l) => l.trim())
  .find((l) => /^llamapad-dsh-plugin-[\w.-]+\.tgz$/.test(l))
if (!tgz) {
  console.error('[release] 未能从 pnpm pack 输出解析出制品文件名')
  process.exit(1)
}
const artifact = resolve(root, tgz)
const sha = createHash('sha256').update(readFileSync(artifact)).digest('hex')

// 旧制品不自动删——留着可用于升级链路验证，确认无用后手动 rm
const stale = readdirSync(root).filter((f) => /^llamapad-dsh-plugin-[\w.-]+\.tgz$/.test(f) && f !== tgz)

console.log(`
✓ 打包完成 ${prev} → ${next}
  制品    ${artifact}（${(statSync(artifact).size / 1024).toFixed(1)} KB）
  sha256  ${sha}
  安装    dsh plugin --profile <名> add ${artifact}
  更新    已装旧版的 profile 重新执行同一条 add 即覆盖更新（层列表不变）
  验证    dsh --profile <名> --dump-config   # 应看到 "# == llamapad-dsh-plugin" 层
  提交    git add package.json && git commit -m "release: v${next}"
${stale.length ? `  注意    根目录还有旧制品：${stale.join('、')}（确认无用后可 rm）` : ''}`)
