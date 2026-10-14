import type { TFile } from "obsidian";

export interface ErrataUiPort {
  openForFile(file: TFile): Promise<void>;
}
