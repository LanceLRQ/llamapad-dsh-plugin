/**
 * dsh 模型选择器的运行状态刷新器。
 *
 * 浏览器侧模型目录（dsh-client-ui-model-selection）按会话惰性加载，此后只在宿主
 * emit `llm/adapters-updated` / `settings/document-updated` 时重拉——不是每次开菜单
 * 都拉，也没有自己的定时器。llamapad 侧模型启停完全是面板一侧的动作，dsh 感知不到，
 * 选择器上的运行状态标记（见 adapter.ts 的 describeModel）会停在挂载那一刻的旧值。
 *
 * 本模块用轮询补上这一环：只在"当前运行中的模型"这个值真的变化时才 emit，避免每轮
 * 空转都打断浏览器侧刚刷出来的目录（`dsh-api-remotes` 的转发白名单已确认
 * `llm/adapters-updated` 在列，宿主侧 emit 会送达浏览器）。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { PanelClient } from "./panel-client";

export interface DirectoryRefreshOptions {
  ctx: Context;
  client: PanelClient;
  /** 轮询间隔（毫秒）；<=0 关闭刷新器，完全不启动定时器 */
  intervalMs: number;
  /** 可注入定时器实现，测试用假实现避免真的等待；默认全局 setTimeout/clearTimeout */
  setTimeoutImpl?: (callback: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
}

export function startDirectoryRefresh(options: DirectoryRefreshOptions): void {
  const { ctx, client, intervalMs } = options;
  // 用正向判定而不是 `intervalMs <= 0`：绕过 schemastery 直接调 apply 的调用方
  // （测试、脚本）可能压根不带这个字段，`undefined <= 0` 为假会放行进去，随后
  // setTimeout(fn, undefined) 等价于 0 毫秒——变成死循环猛打面板。NaN 同理。
  if (!(intervalMs > 0)) return;
  const scheduleTimeout = options.setTimeoutImpl ?? ((callback, ms) => setTimeout(callback, ms));
  const cancelTimeout = options.clearTimeoutImpl ?? ((handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]));

  ctx.effect(() => {
    // undefined = 尚未探测过；首轮只用来定基线，不 emit——插件刚起，目录本来就会加载一次，
    // 这里再 emit 一次纯属多余的空转。
    let baseline: string | null | undefined;
    let stopped = false;
    let handle: unknown;

    async function tick(): Promise<void> {
      try {
        const status = await client.runtimeStatus();
        const current = status.running?.model ?? null;
        if (baseline === undefined) {
          baseline = current;
        } else if (current !== baseline) {
          baseline = current;
          // stopped 二次确认：本轮可能在 await 期间被卸载，此时 ctx 已释放，
          // 往上面 emit 属于对已 dispose 的上下文动手
          if (!stopped) ctx.emit("llm/adapters-updated");
        }
      } catch {
        // PanelError / 网络异常：吞掉并保持上一次基线。面板重启期间会连续探测失败，
        // 不能因此把选择器刷成空，也不能把轮询循环搞死。
      } finally {
        // 一轮结束再排下一轮，而不是 setInterval 的定长节拍——面板响应慢时不会堆积
        // 多轮并发请求；stopped 挡掉"卸载与到期擦肩而过"的竞态：disposer 已经跑过，
        // 这里就不该再排出一个新的定时器。
        if (!stopped) handle = scheduleTimeout(() => { void tick(); }, intervalMs);
      }
    }

    handle = scheduleTimeout(() => { void tick(); }, intervalMs);
    return () => {
      stopped = true;
      cancelTimeout(handle);
    };
  }, "llamapad-directory-refresh");
}
