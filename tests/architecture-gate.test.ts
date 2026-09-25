import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkArchitecture, serviceGraphStats } from "../scripts/check-architecture.mjs";

// 架构门禁的回归保护：基线制（现有债务放行、新增债务失败）+ 双向棘轮（删除须同步收缩基线）。
// 测试不扫描真实仓库，只注入最小源码。
const MAIN = `
class QnALogPlugin {
  async onload() {
    this.alpha = new AlphaService(this);
    this.beta = new BetaService(this);
    this.gamma = new GammaService(this);
  }
}
`;

function files(extra: Record<string, string>) {
  return { "src/main.ts": MAIN, ...extra };
}

function baseline(overrides: { pluginConsumers?: Record<string, string[]>; serviceEdges?: [string, string][] } = {}) {
  return { pluginConsumers: {}, serviceEdges: [], ...overrides };
}

// 三个 legacy 消费者的最小替身：都直接 import main.ts，都通过 this.plugin 取能力。
const TASK_QUEUE = `import type QnALogPlugin from "../main";
export class TaskQueue {
  declare plugin: QnALogPlugin;
  run() { void this.plugin.settings; void this.plugin.tasks; }
}
`;
const RECORDER = `import type QnALogPlugin from "../main";
export class RecorderService {
  declare plugin: QnALogPlugin;
  run() { void this.plugin.settings; void this.plugin.recording; }
}
`;
const OUTLINE = `import type QnALogPlugin from "../main";
export class OutlineView {
  declare plugin: QnALogPlugin;
  run() { void this.plugin.session; void this.plugin.shell; }
}
`;

const LEGACY_BASELINE = {
  "src/queue/task-queue.ts": ["settings", "tasks"],
  "src/audio/recorder-service.ts": ["recording", "settings"],
  "src/ui/outline-view.ts": ["session", "shell"],
};

// 服务依赖图的最小替身：main.ts 装配 alpha/beta/gamma 三个服务，Host 成员名即字段名。
const ALPHA = `export interface AlphaHost {
  beta: BetaService;
}
export class AlphaService {
  declare host: AlphaHost;
}
`;
const ALPHA_WITH_GAMMA = `export interface AlphaHost {
  beta: BetaService;
  gamma: GammaService;
}
export class AlphaService {
  declare host: AlphaHost;
}
`;
const BETA = `export interface BetaHost {
  alpha: AlphaService;
}
export class BetaService {
  declare host: BetaHost;
}
`;
const BETA_NO_ALPHA = `export interface BetaHost {}
export class BetaService {
  declare host: BetaHost;
}
`;
const GAMMA_TO_ALPHA = `export interface GammaHost {
  alpha: AlphaService;
}
export class GammaService {
  declare host: GammaHost;
}
`;
const GAMMA_IDLE = `export interface GammaHost {}
export class GammaService {
  declare host: GammaHost;
}
`;

describe("architecture gate", () => {
  // 场景 1：新文件 import main.ts
  it("拦下新文件对 src/main.ts 的依赖", () => {
    const problems = checkArchitecture(files({
      "src/foo/bar.ts": `import type QnALogPlugin from "../main";\nexport function use(p: QnALogPlugin) { return p; }\n`,
    }), baseline());
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain("src/foo/bar.ts");
    expect(problems[0]).toContain("不得依赖 src/main.ts / QnALogPlugin");
    expect(problems[0]).toContain("请通过显式 Host/capability 注入所需能力");
  });

  // 场景 10：普通纯函数 import
  it("放行不指向 main.ts 的普通 import", () => {
    const problems = checkArchitecture(files({
      "src/foo/util.ts": `import { genId } from "../shared/util-common";\nexport function make() { return genId(); }\n`,
    }), baseline());
    expect(problems).toEqual([]);
  });

  // 场景 2：三个 legacy 文件仍使用已登记的能力
  it("放行三个 legacy 文件对已登记 plugin 能力的使用", () => {
    const problems = checkArchitecture(files({
      "src/queue/task-queue.ts": TASK_QUEUE,
      "src/audio/recorder-service.ts": RECORDER,
      "src/ui/outline-view.ts": OUTLINE,
    }), baseline({ pluginConsumers: LEGACY_BASELINE }));
    expect(problems).toEqual([]);
  });

  // 场景 3：legacy 文件新增一个 plugin member
  it("拦下 legacy 文件新增的 QnALogPlugin 能力", () => {
    const problems = checkArchitecture(files({
      "src/queue/task-queue.ts": TASK_QUEUE.replace(
        "void this.plugin.settings; void this.plugin.tasks;",
        "void this.plugin.settings; void this.plugin.tasks; void this.plugin.imports;",
      ),
    }), baseline({ pluginConsumers: { "src/queue/task-queue.ts": ["settings", "tasks"] } }));
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain("src/queue/task-queue.ts 新增了 QnALogPlugin 能力 imports");
    expect(problems[0]).toContain("TaskQueue 的 legacy plugin 能力面被冻结");
    expect(problems[0]).toContain("请通过独立 controller/port 提供该能力");
  });

  // 验收标准点名的场景：给 OutlineView 增加新的 plugin.* 能力必须失败。
  it("拦下 OutlineView 新增的 QnALogPlugin 能力", () => {
    const problems = checkArchitecture(files({
      "src/ui/outline-view.ts": OUTLINE.replace(
        "void this.plugin.session; void this.plugin.shell;",
        "void this.plugin.session; void this.plugin.shell; void this.plugin.versions;",
      ),
    }), baseline({ pluginConsumers: { "src/ui/outline-view.ts": ["session", "shell"] } }));
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain("src/ui/outline-view.ts 新增了 QnALogPlugin 能力 versions");
    expect(problems[0]).toContain("OutlineView 的 legacy plugin 能力面被冻结");
  });

  // 场景 4：删除一个 legacy plugin member，并同步缩小 baseline
  it("放行删除能力并同步收缩基线", () => {
    const problems = checkArchitecture(files({
      "src/queue/task-queue.ts": `import type QnALogPlugin from "../main";
export class TaskQueue {
  declare plugin: QnALogPlugin;
  run() { void this.plugin.settings; }
}
`,
    }), baseline({ pluginConsumers: { "src/queue/task-queue.ts": ["settings"] } }));
    expect(problems).toEqual([]);
  });

  it("拦下删除能力但未收缩的基线（棘轮回涨方向）", () => {
    const problems = checkArchitecture(files({
      "src/queue/task-queue.ts": `import type QnALogPlugin from "../main";
export class TaskQueue {
  declare plugin: QnALogPlugin;
  run() { void this.plugin.settings; }
}
`,
    }), baseline({ pluginConsumers: { "src/queue/task-queue.ts": ["settings", "tasks"] } }));
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain("基线能力 tasks 已不再被使用");
    expect(problems[0]).toContain("棘轮只允许收缩");
  });

  // 场景 5：Host 保持已有 service edge
  it("放行与基线一致的服务依赖边（含基线内已有的环）", () => {
    const problems = checkArchitecture(files({
      "src/foo/alpha.ts": ALPHA,
      "src/foo/beta.ts": BETA,
    }), baseline({ serviceEdges: [["AlphaService", "BetaService"], ["BetaService", "AlphaService"]] }));
    expect(problems).toEqual([]);
  });

  // 场景 6：Host 新增 service edge
  it("拦下 Host 接口新增的服务依赖边", () => {
    const problems = checkArchitecture(files({
      "src/foo/alpha.ts": ALPHA_WITH_GAMMA,
      "src/foo/beta.ts": BETA,
    }), baseline({ serviceEdges: [["AlphaService", "BetaService"], ["BetaService", "AlphaService"]] }));
    const edge = problems.find((p) => p.includes("新增服务依赖"));
    expect(edge).toBeDefined();
    expect(edge).toContain("AlphaService -> GammaService");
    expect(edge).toContain("来源：AlphaHost.gamma");
    expect(edge).toContain("现有架构基线中不存在该边");
  });

  // 场景 7：删除已有 service edge，并同步 baseline
  it("放行删除服务依赖边并同步收缩基线", () => {
    const problems = checkArchitecture(files({
      "src/foo/alpha.ts": ALPHA,
      "src/foo/beta.ts": BETA_NO_ALPHA,
    }), baseline({ serviceEdges: [["AlphaService", "BetaService"]] }));
    expect(problems).toEqual([]);
  });

  it("拦下删除服务依赖边但未收缩的基线", () => {
    const problems = checkArchitecture(files({
      "src/foo/alpha.ts": ALPHA,
      "src/foo/beta.ts": BETA_NO_ALPHA,
    }), baseline({ serviceEdges: [["AlphaService", "BetaService"], ["BetaService", "AlphaService"]] }));
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain("基线中的服务依赖 BetaService -> AlphaService 已不存在");
  });

  // 场景 8：新 edge 形成新 cycle —— FAIL，并打印 cycle
  it("拦下形成新依赖环的边并打印环路径", () => {
    const problems = checkArchitecture(files({
      "src/foo/alpha.ts": ALPHA,
      "src/foo/beta.ts": BETA,
    }), baseline({ serviceEdges: [["AlphaService", "BetaService"]] }));
    const cycle = problems.find((p) => p.includes("形成了新的依赖环"));
    expect(cycle).toBeDefined();
    expect(cycle).toContain("环：AlphaService -> BetaService -> AlphaService");
    // 未入基线的新边本身也必须被点名
    expect(problems.some((p) => p.includes("新增服务依赖：\nBetaService -> AlphaService"))).toBe(true);
  });

  // 场景 9：新 edge 扩大已有 SCC
  it("拦下扩大既有依赖环的边", () => {
    const problems = checkArchitecture(files({
      "src/foo/alpha.ts": ALPHA_WITH_GAMMA,
      "src/foo/beta.ts": BETA,
      "src/foo/gamma.ts": GAMMA_TO_ALPHA,
    }), baseline({ serviceEdges: [["AlphaService", "BetaService"], ["BetaService", "AlphaService"]] }));
    const expansion = problems.find((p) => p.includes("把既有依赖环扩大了"));
    expect(expansion).toBeDefined();
    expect(expansion).toContain("{ AlphaService, BetaService }");
    expect(expansion).toContain("AlphaService, BetaService, GammaService");
    expect(expansion).toContain("环：");
  });

  // 统计输出：service count / edge count / cyclic SCC count / largest SCC size
  it("输出服务依赖图统计", () => {
    const stats = serviceGraphStats(files({
      "src/foo/alpha.ts": ALPHA,
      "src/foo/beta.ts": BETA,
      "src/foo/gamma.ts": GAMMA_IDLE,
    }));
    expect(stats).toEqual({ services: 3, edges: 2, cyclicSccs: 1, largestScc: 2 });
  });

  // 检查脚本自身只读源码：不依赖 GitHub、网络、构建产物或 git。
  // 判据是导入白名单——只有 node:fs / node:path / node:url / typescript 四个来源，
  // 拿不到 child_process、http 客户端或 git 命令；再补三个字符串断言兜底。
  it("检查脚本自身不依赖网络、构建产物或 git", () => {
    const source = readFileSync(new URL("../scripts/check-architecture.mjs", import.meta.url), "utf8");
    const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]).sort();
    expect(specifiers).toEqual(["node:fs", "node:path", "node:url", "typescript"]);
    expect(source).not.toMatch(/github/i);
    expect(source).not.toMatch(/https?:\/\//);
    expect(source).not.toContain("child_process");
    expect(source).not.toContain("main.js");
  });
});
