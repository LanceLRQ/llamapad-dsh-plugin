import { describe, expect, it } from "vitest";
import {
  connectionChanged, createUnconfiguredClient, isConnectionComplete, readConnection,
  type ConnectionParams,
} from "../../src/connection";

function params(patch: Partial<ConnectionParams> = {}): ConnectionParams {
  return { panelUrl: "http://panel:8080", token: "lp_a", mode: "proxy",
           requestTimeoutMs: 30000, ...patch };
}

describe("readConnection：从 Config 摘出连接相关字段", () => {
  it("只取连接相关字段，忽略 chatBehavior 等无关项", () => {
    const got = readConnection({ panelUrl: "http://p:1", token: "t", mode: "proxy",
                                 requestTimeoutMs: 5000, chatBehavior: "strict" } as never);
    expect(got).toEqual({ panelUrl: "http://p:1", token: "t", mode: "proxy",
                          requestTimeoutMs: 5000 });
  });

  it("direct 模式带出 llamaBaseUrl", () => {
    const got = readConnection({ panelUrl: "http://p:1", token: "t", mode: "direct",
                                 llamaBaseUrl: "http://l:2", requestTimeoutMs: 5000 } as never);
    expect(got.llamaBaseUrl).toBe("http://l:2");
  });
});

describe("isConnectionComplete：能不能真的去连面板", () => {
  it("两项齐全 → true", () => {
    expect(isConnectionComplete(params())).toBe(true);
  });

  it("缺 panelUrl → false", () => {
    expect(isConnectionComplete(params({ panelUrl: "" }))).toBe(false);
  });

  it("缺 token → false", () => {
    expect(isConnectionComplete(params({ token: "" }))).toBe(false);
  });

  it("只有空白字符不算填了", () => {
    expect(isConnectionComplete(params({ panelUrl: "   " }))).toBe(false);
  });
});

describe("connectionChanged：要不要换一套 client", () => {
  it("完全相同 → false", () => {
    expect(connectionChanged(params(), params())).toBe(false);
  });

  it("token 变了 → true", () => {
    expect(connectionChanged(params(), params({ token: "lp_b" }))).toBe(true);
  });

  it("panelUrl 变了 → true", () => {
    expect(connectionChanged(params(), params({ panelUrl: "http://other:9" }))).toBe(true);
  });

  it("超时变了 → true（createPanelClient 构造期就固化了它）", () => {
    expect(connectionChanged(params(), params({ requestTimeoutMs: 60000 }))).toBe(true);
  });

  it("prev 为 null（首次构造）→ true", () => {
    expect(connectionChanged(null, params())).toBe(true);
  });
});

describe("createUnconfiguredClient：未配置时的占位", () => {
  it("listModels 抛出指路的中文错误，而不是返回空数组", async () => {
    await expect(createUnconfiguredClient().listModels())
      .rejects.toThrow(/面板地址|token/);
  });

  it("runtimeStatus 同样抛错，不伪装成「没有模型在跑」", async () => {
    await expect(createUnconfiguredClient().runtimeStatus()).rejects.toThrow();
  });

  it("llamaHealth 返回 false 而不抛错（它的契约是布尔探测，调用方按 false 处理即可）", async () => {
    await expect(createUnconfiguredClient().llamaHealth()).resolves.toBe(false);
  });

  it("getReasoningInfo 返回 null（契约就是「不可知一律 null」，抛错反而破坏它）", async () => {
    await expect(createUnconfiguredClient().getReasoningInfo()).resolves.toBeNull();
  });
});
