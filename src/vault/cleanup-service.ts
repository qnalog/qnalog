/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 知识库清理：删除符合条件的历史文件（空白短录音及其音频）。
// 由 main.ts 抽出（模块化拆解，纯搬迁）。

import type * as obsidian from "obsidian";
import { qnalogConfirm, trashVaultFileRef } from "../ui/helpers";
import type { PluginSettings } from "../shared/types";
import type { SessionStore } from "../session/session-store";
import { resolveAudioFileRef } from "../notes/audio-refs";
import { runEmptyShortRecordingCleanup } from "./empty-short-cleanup-flow";
import { TaskQueue } from "../queue/task-queue";

/** CleanupService 需要宿主提供的能力；运行时由 src/main.ts 的插件实例实现。 */
export interface CleanupHost {
  /** 知识库与工作区访问。 */
  app: obsidian.App;
  queue: TaskQueue | null;
  saveAll(): Promise<void>;
  sessionStore: SessionStore;
  /** 设置对象本身，不拷贝；服务直接读字段。 */
  settings: PluginSettings;
}

export class CleanupService {
  declare host: CleanupHost;
  constructor(host: CleanupHost) {
    this.host = host;
  }

  cleanupEmptyShortRecordings(): Promise<void> {
    return runEmptyShortRecordingCleanup({
      getMdFolder: () => this.host.settings.mdFolder,
      getVault: () => this.host.app.vault,
      getCurrentSessionPath: () => {
        const session = this.host.sessionStore.get();
        return session && session.mdPath ? session.mdPath : null;
      },
      resolveAudio: (ref) => resolveAudioFileRef(this.host.app, this.host.settings, ref),
      confirm: (title, body, cta) => qnalogConfirm(this.host.app, title, body, cta),
      trash: (file) => trashVaultFileRef(this.host.app, file),
      getQueue: () => this.host.queue,
      save: () => this.host.saveAll(),
    });
  }
}
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
