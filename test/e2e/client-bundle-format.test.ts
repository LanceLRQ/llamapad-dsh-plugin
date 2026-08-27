// 产物格式回归：把主进程手工验证过一次的加载方式固化成测试，防止日后构建配置
// （scripts/build.mjs）改动悄悄打碎浏览器产物的加载契约。用 node:vm 模拟宿主的
// window.__ModuleLoader__.load({ id, factory }) 调用约定，断言：
//   1. 注册 id 与 package.json 的包名逐字一致；
//   2. materialize 后的导出含 apply（async 函数）与 inject（数组，覆盖三个必需服务）；
//   3. factory 内 require 的外部名全部落在 SEED_MODULES 这 7 项种子表里——这条最要紧，
//      落表外在真机上是 loud throw（见 scripts/build.mjs 顶部注释）。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DIST_CLIENT = path.join(ROOT, "dist/client.js");

/** 与 scripts/build.mjs 的 SEED_MODULES 逐字一致：宿主真机只有这 7 个名字能被 require 到。 */
const SEED_NAMES = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-primitives",
] as const;

interface CapturedLoad {
  readonly id: string;
  readonly exports: Record<string, unknown>;
}

/**
 * 用 vm 沙箱跑一遍 dist/client.js，模拟宿主 __ModuleLoader__ 的加载约定。
 * 种子表全部塞空对象——factory 顶层只做 import 绑定（module-init 阶段），
 * 组件真正渲染 / hook 调用要等宿主实际挂载卡片才发生，这次加载不会碰到。
 */
function loadClientBundle(): { captured: CapturedLoad; requested: string[] } {
  const source = readFileSync(DIST_CLIENT, "utf8");
  const seeds: Record<string, object> = Object.fromEntries(SEED_NAMES.map((name) => [name, {}]));
  const requested: string[] = [];
  let captured: CapturedLoad | null = null;

  const sandbox: Record<string, unknown> = {
    window: {
      __ModuleLoader__: {
        load: (registration: { id: string; factory: (req: (spec: string) => unknown) => Record<string, unknown> }) => {
          const req = (spec: string): unknown => {
            requested.push(spec);
            if (!(spec in seeds)) throw new Error(`require 落空（不在种子表内): ${spec}`);
            return seeds[spec];
          };
          captured = { id: registration.id, exports: registration.factory(req) };
        },
      },
    },
    Object,
    Symbol,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: DIST_CLIENT });

  if (captured === null) {
    throw new Error("dist/client.js 没有调用 window.__ModuleLoader__.load(...)，产物格式已经变了");
  }
  return { captured, requested };
}

describe("dist/client.js 产物格式回归", () => {
  beforeAll(() => {
    // 构建配置本身就是这份测试要钉住的东西：先跑一遍真实构建（而不是直接读一份
    // 可能过期的 dist/），再对刚产出的文件断言。
    execFileSync("node", ["scripts/build.mjs"], { cwd: ROOT, stdio: "pipe" });
  });

  it("注册 id 与 package.json 的包名逐字一致", () => {
    const { captured } = loadClientBundle();
    expect(captured.id).toBe("llamapad-dsh-plugin");
  });

  it("导出 apply（async 函数）与 inject（数组，覆盖 slots/remote/locale）", () => {
    const { captured } = loadClientBundle();
    expect(typeof captured.exports["apply"]).toBe("function");
    expect((captured.exports["apply"] as { constructor: { name: string } }).constructor.name).toBe("AsyncFunction");

    const inject = captured.exports["inject"];
    expect(Array.isArray(inject)).toBe(true);
    for (const service of ["slots", "remote", "locale"]) {
      expect(inject).toContain(service);
    }
  });

  it("factory 里每一个 require 的外部名都落在 7 个种子表内", () => {
    const { requested } = loadClientBundle();
    // 至少要真的发生过 require（否则这条断言是空对空，测不出东西）
    expect(requested.length).toBeGreaterThan(0);
    for (const spec of requested) {
      expect(SEED_NAMES as readonly string[]).toContain(spec);
    }
  });
});
