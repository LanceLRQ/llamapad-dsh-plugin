#!/usr/bin/env node
// 多版本测试矩阵：仓库默认对着最新一代（0.2.0）做类型检查和测试；本脚本把仓库复制到
// 临时目录，devDependencies 里的框架包依次换成更早的世代，装好后跑单测和假面板 E2E。
// 不跑 typecheck：类型以最新一代为准，老世代只验证运行时行为。
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// 按新到旧排列；dsh 是 @deepseek-ai/dsh-* 全系的版本，cordis/schemastery 是当代宿主的版本。
const GENERATIONS = [
  {
    dsh: '0.1.7-rc.1',
    '@deepseek-ai/cordis': '4.0.4',
    '@deepseek-ai/schemastery': '3.18.4',
  },
  {
    dsh: '0.1.5-rc.3',
    '@deepseek-ai/cordis': '4.0.2',
    '@deepseek-ai/schemastery': '3.18.2',
  },
]

const root = process.cwd()
const skip = new Set(['node_modules', 'dist', '.git'])

for (const legacy of GENERATIONS) {
  const dir = mkdtempSync(join(tmpdir(), 'llamapad-compat-'))

  function run(cmd, args) {
    const r = spawnSync(cmd, args, { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' })
    if (r.status !== 0) {
      console.error(`[test:compat] 失败：${cmd} ${args.join(' ')}（临时目录保留在 ${dir}）`)
      process.exit(r.status ?? 1)
    }
  }

  cpSync(root, dir, {
    recursive: true,
    filter: (src) => !skip.has(src.slice(root.length + 1).split(/[\\/]/)[0]) && !src.endsWith('.tgz'),
  })

  const pkgPath = join(dir, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  for (const name of Object.keys(pkg.devDependencies)) {
    if (name in legacy) pkg.devDependencies[name] = legacy[name]
    else if (name.startsWith('@deepseek-ai/dsh-')) pkg.devDependencies[name] = legacy.dsh
  }
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2))
  rmSync(join(dir, 'pnpm-lock.yaml'), { force: true })

  console.log(`[test:compat] 在 ${dir} 以 dsh ${legacy.dsh} 框架运行单测与 E2E`)
  run('pnpm', ['install', '--no-frozen-lockfile'])
  run('pnpm', ['test'])
  run('pnpm', ['run', 'test:e2e'])
  rmSync(dir, { recursive: true, force: true })
}

console.log('[test:compat] 通过')
