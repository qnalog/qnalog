/**
 * 中文词条表：键为英文原文，值为中文译文。
 *
 * 只有**已经过 `t()` 包裹**的字符串需要在这里登记。未登记的条目
 * 在中文界面下会显示英文原文——那是"漏译"，一眼可见，便于补齐。
 *
 * 新增译文时保持键与代码里的英文原文逐字一致（含标点与空格）：
 * 键不一致等于没翻译，且不会有任何报错。
 */
import type { MessageTable } from "../../i18n";

export const ZH: MessageTable = {
  // —— 通用控件 ——
  "Save": "保存",
  "Save and enable": "保存并启用",
  "Cancel": "取消",
  "OK": "确定",
  "Close": "关闭",
  "Delete": "删除",
  "Clear": "清空",
  "Reset": "重置",
  "Restore default": "恢复默认",
  "Test": "测试",
  "Testing…": "测试中…",
  "Check": "检测",
  "Checking…": "检测中…",
  "Fetching…": "获取中…",
  "Saving…": "保存中…",
  "Processing…": "处理中…",
  "Loading…": "正在加载…",
  "Select": "选择",
  "More": "更多",
  "Pause": "暂停",

  // —— 设置页：选项卡与首页 ——
  "Status": "使用状态",
  "Ready": "已准备好",
  "Core setup is complete. You can start recording.": "核心配置已完成，可以开始录音。",
  "Still need": "还需要完成",
  "item(s)": "项配置",
  "Quick setup": "快速设置",
  "Provider": "服务商",
  "API key": "API Key",
  "Enter an API key first": "请先填写 API Key",
  "Enter the API key for this provider. Keys are stored only in this vault's plugin settings.":
    "填入该服务商的 API Key。密钥只保存在本库的插件设置中。",
  "Setup complete. You can start recording.": "配置完成，可以直接开始录音了。",
  "Check failed": "检测失败",
  "Check only": "仅检测",
  "Quick config": "快速配置",
  "Open sidebar": "打开侧边栏",

  // —— 设置首页：头部与页脚 ——
  "Record, transcribe, and organize into Markdown notes. Default services, models, and parameters are preset \u2014 add an API key when you are ready.":
    "录音、转写并整理为 Markdown 纪要。默认服务、模型与参数都已选好，按需填入 API 密钥即可开始。",
  "Costs: the Q&A Log plugin itself is free. Cloud transcription and LLM services bill per usage on their own platforms; local models incur no platform fees but you install, run, and maintain them yourself.":
    "费用说明：Q&A Log 插件本身免费。云端转写与大模型服务由对应平台按量计费；本地模型不产生平台费用，但需自行安装、启动与维护。",

  // —— 音频输入与设备 ——
  "Detect devices": "检测设备",
  "Audio input": "音频输入",
  "Speaker labels": "说话人识别",
  "Transcription": "语音转写",
  "\u300cAudio input\u300d needs microphone permission to read device names. Click the button to read them once; recording will not start.":
    "「音频输入」需要麦克风授权才能读到设备名。点右侧按钮读取一次；不会开始录音。",
  "Could not read the device list. Grant microphone permission, then use \u201cDetect devices\u201d.":
    "无法读取设备列表。请先授予麦克风权限，再点「设备检测」。",
  "Could not read the device list. Grant microphone permission, then choose a device.":
    "无法读取设备列表。请先授予麦克风权限，再选择设备。",
  "The selected computer-audio device may be disconnected. Choose another.":
    "当前已选电脑音频设备可能已断开。请重新选择。",
  "The selected microphone is disconnected. Choose another.":
    "所选麦克风未连接，请重新选择。",
  "No audio input device found. Install a virtual audio device first.":
    "未检测到任何音频输入设备。请先安装虚拟声卡。",
  "No audio input device found. Check that your microphone is connected and that the system grants permission.":
    "未检测到任何音频输入设备。请检查麦克风是否已连接、系统是否授予权限。",
  "No virtual audio device recognized, so all input devices are listed. Pick the one that carries computer audio.":
    "未识别出虚拟声卡，已列出全部输入设备；若其中有采集电脑声音的那一只，选它即可。",
  "No computer-audio input found. Set up a virtual audio device first.":
    "未找到电脑音频输入。请先设置虚拟声卡。",
  "Use this device for recording.": "使用此设备录音。",
  "Uses the system default input. When recording speech, choosing a microphone explicitly is recommended.":
    "使用系统默认输入设备。录制人声时，建议明确选择麦克风。",
  "Pick the virtual audio device that captures computer audio (usually CABLE Output, BlackHole, and similar).":
    "请手动选择采集电脑声音的虚拟声卡输入（通常是 CABLE Output / BlackHole 等）。",
  "Sound played on the computer will be recorded from this input.":
    "电脑播放的声音会从这个输入录入。",
  "Mobile uses the system microphone; configure computer audio and virtual audio devices on desktop.":
    "移动端使用系统麦克风；电脑音频和虚拟声卡采集请在桌面端配置。",
  "Mobile does not support computer-audio capture; configure a virtual audio device on desktop.":
    "移动端不支持电脑音频采集，请在桌面端配置虚拟声卡。",
  "CABLE Output is what recording apps like Q&A Log read to capture computer audio; it is not suitable as your everyday microphone.":
    "CABLE Output 是给 Q&A Log 这类录音软件读取电脑音频用的，不适合作为日常语音输入麦克风。",
  "Note: you are selecting CABLE Input here. Despite the name, Windows treats it as a playback device; Q&A Log later records from CABLE Output at the other end of the same virtual cable.":
    "注意：这里选的是 CABLE Input。虽然名字叫 Input，但它在 Windows 里是\u201c播放/输出设备\u201d；Q&A Log 后面录的是同一根虚拟线缆另一端的 CABLE Output。",
  "Q&A Log cannot listen directly to sound playing through your headphones or speakers. To record from a browser, a course, or the other side of a meeting, route that sound to a virtual audio device so Q&A Log recognizes it as computer-audio input, and monitor the same sound to your real speakers or headphones so you can still hear it. Configure once and it keeps working.":
    "Q&A Log 不能直接监听耳机或扬声器里正在播放的声音。录制 B 站客户端、浏览器视频、课程或会议对方声音时，需要先把这些声音输出到虚拟声卡，让 Q&A Log 将其识别为「电脑音频输入」；同时再把同一份声音监听到真实扬声器或耳机，确保本机仍可听到播放内容。一次配置，长期可用。",
  "This makes system audio go to both your real speakers/headphones and BlackHole: the former for playback, the latter for Q&A Log to record.":
    "这样系统音频会同时进入真实耳机/扬声器和 BlackHole：前者用于播放，后者用于 Q&A Log 录制。",
  "This step temporarily stops system audio playing through your real headphones/speakers; listening is restored by the next step.":
    "这一步会让系统声音暂时不从真实耳机/扬声器播放，需要完成下一步侦听设置后恢复监听。",
  "The audio path is: app/browser \u2192 CABLE Input (playback) \u2192 CABLE Output (recording input, read by Q&A Log) \u2192 monitored to real headphones/speakers. If monitoring latency is noticeable, use a mixer such as VoiceMeeter for multiple outputs.":
    "音频链路是：应用/浏览器 → CABLE Input（播放输出）→ CABLE Output（录制输入，Q&A Log 读取）→ 侦听到真实耳机/扬声器。若侦听延迟明显，可改用 VoiceMeeter 这类混音工具做多输出。",
  "Meeting apps may need you to reselect the speaker after switching.":
    "切换后会议软件可能需要重新选择扬声器。",
  "All channels carry identical content. Set the receiver output to \u201cStereo\u201d and try again.":
    "各声道内容相同。请在接收器上把输出改为「Stereo（立体声）」后重试。",
  "Test passed. Each channel will be labelled Speaker 1, Speaker 2, and so on.":
    "测试通过。各声道将分别标记为说话人1、说话人2……",
  "The current import transcription model does not support speaker separation.":
    "当前导入转写模型不支持说话人区分。",
  "The current model supports speaker separation, but the number of speakers is detected automatically.":
    "当前模型支持区分说话人，但人数由模型自动识别。",
  "Enter the number of speakers to reduce merging of similar voices; leave empty to detect automatically.":
    "填写实际发言人数可减少相近声音被合并；留空则自动识别。",
  "Volume": "音量",
  "Pick a time": "选时间",

  // —— 转写服务说明 ——
  "Live mode: the connection stays open for the whole recording and text appears as you speak; audio is no longer uploaded in segments. \u201cSegment interval\u201d and \u201cInterim segment transcription\u201d on the Recording tab have no effect for this service.":
    "实时模式：录音全程与服务保持连线，边说边出文字，不再切段上传。「录音」页中的「分段间隔」「即时分段」对此服务不生效。",
  "OpenAI Realtime translation": "OpenAI Realtime 翻译",

  // —— 提示词与模板 ——
  "AI refine prompt": "AI 优化提示词",
  "Refining…": "优化中…",
  "Refining prompt": "优化提示词中",
  "Open prompt library": "打开模板库",
  "Built-in templates can be used as-is; custom templates appear in the selection lists for recording, import, and re-organize.":
    "内置模板可直接使用；自定义模板会出现在录音、导入和重新整理的选择列表中。",
  "This is where refinement rules are managed. Built-in prompts get you started quickly; create a custom prompt and set it as default when you need a fixed format, professional judgement, or a long-running workflow.":
    "这里集中管理整理规则。内置提示词用于快速开始；需要固定格式、职业化判断或长期工作流时，新建自定义提示词并设为默认。",
  "Suitable for multilingual meetings: output one language throughout, or keep key original text in parentheses.":
    "适用于多语种会议，可统一输出语言或保留关键原文括注。",
  "Only the refined result is adjusted by default; the raw transcript is left untouched. Repolish preference applies only to derived versions created from the context menu.":
    "默认只调整整理结果，不改动原始转写。重新整理偏好仅作用于右键菜单中的派生版本。",

  // —— 资料库 ——
  "Open to-do wall": "打开待办墙",
  "Extract people suggestions": "提取人员建议",
  "Extract transcript terms": "提取转写词表",
  "Merge duplicate people": "合并重复人员",
  "Pending": "待确认",
  "Ignored": "已忽略",
  "Clear people records": "清空人员记录",
  "Clear term records": "清空词表记录",
  "People directory": "人员资料",
  "All notes": "全部纪要",
  "Backfill views": "补齐视图",
  "A new people record will be created with the candidate name.":
    "将使用候选姓名新建一份人员档案。",
  "This suggestion will be recorded as mentioned in this meeting and attached to the currently matched people record.":
    "将把本条建议作为本次会议提及，挂到当前匹配的人员档案。",
  "Rescanning regenerates four sets of candidates; items already added to the library are not deleted.":
    "重新扫描会重新生成四组候选，已经加入库里的内容不会自动删除。",
  "The report uses the same note content and does not modify the original note in Obsidian.":
    "报告使用同一份纪要内容，不会改变 Obsidian 中的原始纪要。",

  // —— 更新与诊断 ——
  "Check for updates": "检查更新",
  "Open GitHub": "打开 GitHub",
  "Open releases page": "打开发布页",
  "View versions": "查看版本",
  "Copy diagnostic report": "复制诊断报告",
  "Get available models": "获取可用模型",
  "Get models": "获取模型",

  // —— 选择导入内容 ——
  "Choose existing Markdown, a dictation draft, or a text note. Q&A Log will not call speech transcription; it goes straight through the \u201cAI briefing\u201d LLM pipeline on the API tab and structures the text using the current template.":
    "选择已有 Markdown、速录稿或文本纪要。Q&A Log 不会调用语音转写服务，会直接走 API 页的「AI 整理服务」LLM 链路并按当前模板结构化整理。",
  "Choose report colour scheme": "选择报告配色",
  "Reuse transcription key": "复用转写密钥",
  "Reuse MiMo transcription key": "复用 MiMo 转写密钥",
  "Generate an outline once recording has started and the first segment is produced.":
    "录音开始且产出第一段后可生成大纲。",
  "Click Refresh to turn scattered remarks into an outline.":
    "点「刷新」，把零散的发言整理成一份提纲。",
  "The model is returning content": "模型正在返回内容",
  "Scan": "扫描",
  "Scan and clean": "扫描并清理",
  "Open queue": "打开队列",
  "Board": "看板",
  "Notes": "纪要",
  "Settings": "设置",
  "Revoke consent": "撤销授权",
  "People": "人",
  "Send": "发",
  "Ask": "问",
};
