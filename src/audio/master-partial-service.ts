// 录音母带增量落盘的装配服务：登记进行中的场次、正式保存后删除分片、启动时恢复中断录音并给出通知。
// 只通过函数形式的端口访问宿主能力，不持有插件或其他服务的引用。

import { t } from "../shared/i18n";
import { diagnosticError } from "../shared/util-key-diag";
import { getErrorMessage } from "../shared/util-common";
import {
  MasterPartialSession,
  markPartialSaved,
  partialSessionPath,
  removePartialDirectory,
  type MasterPartialAdapter,
  type MasterPartialSessionInit,
} from "./master-partial";
import { recoverInterruptedMasterPartials, type MasterPartialRecoveryOutcome } from "./master-partial-recovery";

/** 通知按钮的最小接口：只需要挂一个按钮。 */
export interface MasterPartialNotice {
  addButton(label: string, onClick: () => void): void;
}

export interface MasterPartialHost {
  adapter: MasterPartialAdapter;
  getAudioFolder(): string;
  logDiagnostic(level: string, code: string, message: string, data: unknown): Promise<void>;
  /** 导入录音文件（路径为知识库内路径）；返回值不使用。 */
  importAudioFiles(paths: string[]): Promise<unknown>;
  /** 显示通知；timeoutMs 为 0 时保持显示直到用户关闭。 */
  showNotice(message: string, timeoutMs: number): MasterPartialNotice;
}

export class MasterPartialService {
  private readonly host: MasterPartialHost;
  /** 本次运行中已创建、尚未完成正式保存的场次。 */
  private readonly active = new Map<string, MasterPartialSession>();

  constructor(host: MasterPartialHost) {
    this.host = host;
  }

  /** 录音开始时调用：登记场次，返回分片写入器。 */
  createSession(init: MasterPartialSessionInit): MasterPartialSession {
    const session = new MasterPartialSession(this.host.adapter, init);
    this.active.set(init.sessionId, session);
    return session;
  }

  /**
   * 完整母带保存成功后调用：先等待进行中的分片写入结束，再删除分片目录。
   * 删除失败时在 meta.json 中记下 savedAs，下次启动只清理目录，不会把同一段音频再恢复一次。
   */
  async discard(sessionId: string, savedPath: string): Promise<void> {
    const session = this.active.get(sessionId);
    const dir = session ? session.directory : partialSessionPath(this.host.getAudioFolder(), sessionId);
    if (session) {
      session.close();
      await session.drain();
    }
    this.active.delete(sessionId);
    try {
      await removePartialDirectory(this.host.adapter, dir);
    } catch (error) {
      await this.host.logDiagnostic("warn", "recording.partial_cleanup_failed", t("The full recording was saved, but its partial files could not be removed"), {
        sessionId,
        error: diagnosticError(error),
      });
      try {
        await markPartialSaved(this.host.adapter, dir, savedPath);
      } catch (markError) {
        await this.host.logDiagnostic("warn", "recording.partial_mark_failed", t("The partial files could not be marked as saved"), {
          sessionId,
          error: diagnosticError(markError),
        });
      }
    }
  }

  /** 启动时调用一次：恢复非活动场次的分片，并为每个恢复结果显示通知。 */
  async recoverInterrupted(): Promise<MasterPartialRecoveryOutcome[]> {
    let outcomes: MasterPartialRecoveryOutcome[];
    try {
      outcomes = await recoverInterruptedMasterPartials({
        adapter: this.host.adapter,
        audioFolder: this.host.getAudioFolder(),
        isActiveSession: (sessionId) => this.active.has(sessionId),
        logDiagnostic: (level, code, message, data) => this.host.logDiagnostic(level, code, message, data),
      });
    } catch (error) {
      await this.host.logDiagnostic("error", "recording.recovery_failed", t("An interrupted recording could not be recovered; its partial files were kept"), {
        reason: "scan-failed",
        error: diagnosticError(error),
      });
      return [];
    }
    for (const outcome of outcomes) {
      if (outcome.status === "recovered") this.showRecoveredNotice(outcome.path);
      if (outcome.status === "failed") {
        this.host.showNotice(t("An interrupted recording could not be recovered automatically. Its partial files are kept in the recording folder."), 0);
      }
    }
    return outcomes;
  }

  private showRecoveredNotice(path: string): void {
    const name = path.split("/").pop() || path;
    const notice = this.host.showNotice(
      t("A previous recording was interrupted before it was saved. Its audio was saved in the recording folder as {0}.").replace("{0}", name),
      0,
    );
    notice.addButton(t("Import and transcribe"), () => {
      this.host.importAudioFiles([path]).catch((error: unknown) => {
        this.host.showNotice(`${t("Import failed: ")}${getErrorMessage(error)}`, 8000);
      });
    });
  }
}
