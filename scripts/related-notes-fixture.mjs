function note(path, sourceId, title, summary, bodyExcerpt, timestamp, unresolvedTargets = [], outLinks = [], isMergeNote = false, hasIndexCard = true) {
  return {
    path, sourceId, title, timestamp, tags: [], people: [], topics: [], summary,
    decisions: [], actions: [], questions: [], bodyExcerpt, outLinks, inLinks: [], inLinkOutDegrees: {},
    unresolvedTargets, precision: "full", hasIndexCard, isMergeNote,
  };
}

export function createRelatedNoteEvalFixture() {
  const groups = [
    [["航线优化", "林岚决定宁波厦门航线燃油成本降低12%", "项目X"], ["Route planning", "Lin Lan chose a twelve percent fuel cost reduction on Ningbo Xiamen route", "项目X"], ["船队燃料", "林岚负责宁波厦门线路节油目标12%", "项目X"]],
    [["客户续约", "陈明决定提前30天联系华东续约客户", "Retention plan"], ["Retention plan", "Chen Ming contacts East China customers one month before renewal", "Retention plan"], ["续约提醒", "华东客户到期前三十日提醒由陈明负责", "Retention plan"]],
    [["推理延迟", "周琪决定响应时间低于200毫秒并测试缓存", "推理服务"], ["Inference latency", "Zhou Qi targets a response time under 200 milliseconds and tests caching", "推理服务"], ["响应耗时", "周琪先验证缓存，推理响应须小于200毫秒", "推理服务"]],
  ];
  const corpus = [];
  const goldGroups = [];
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const paths = [];
    for (let noteIndex = 0; noteIndex < groups[groupIndex].length; noteIndex++) {
      const [title, summary, target] = groups[groupIndex][noteIndex];
      const path = `topic-${groupIndex}/${noteIndex}.md`;
      paths.push(path);
      corpus.push(note(path, path, title, summary, summary, noteIndex, [target.toLocaleLowerCase()]));
    }
    goldGroups.push(paths);
  }
  corpus.push({ ...note("old/旧笔记.md", "old", "旧笔记", "", "林岚负责宁波厦门路线的燃油成本核算，结合船队每天航行时间和天气变化，确认节油目标为百分之十二。团队比较了两条航线，保留能够降低燃料消耗并按月检查的方案。", 0, [], [], false, false), precision: "body-only" });
  const shortNotePath = "topic/【个人笔记】AI视频制作-分镜坐标系规范.md";
  corpus.push({ ...note(shortNotePath, "short-note", "AI视频制作-分镜坐标系规范", "", "测试 hyperframes 这个词", 9, [], [], false, false), precision: "body-only" });
  const boilerplate = "本次、主要、包括、核心、记录、当前、使用、情况、梳理、围绕、涉及、针对、部分、过程、重点、目的、此外、同时、首先";
  const boilerplatePaths = ["boilerplate/主题A.md", "boilerplate/主题B.md"];
  corpus.push(note(boilerplatePaths[0], "boilerplate-a", "冷却系统", boilerplate, boilerplate, 10));
  corpus.push(note(boilerplatePaths[1], "boilerplate-b", "人员排班", boilerplate, boilerplate, 11));
  const distractors = [
    ["noise/meeting-a.md", "周会 项目进展", "会议讨论项目进展，确定本周会议事项"],
    ["noise/meeting-b.md", "项目会议进展", "项目会议复盘进展和下一次会议时间"],
    ["noise/meeting-c.md", "会议室设备", "会议室投影设备更换"],
    ["noise/finance.md", "季度预算", "财务预算核对"],
    ["noise/garden.md", "阳台植物", "花盆和土壤养护"],
    ["noise/music.md", "弦乐演出", "排练巴洛克音乐"],
  ];
  corpus.push(...distractors.map(([path, title, body], index) => note(path, path, title, body, body, index)));
  const linkNotes = [
    note("link/A.md", "link-A", "Orbital transfer", "", "heliocentric maneuver", 1, ["semantic transfer"]),
    note("link/B.md", "link-B", "轨道换乘", "", "星际轨迹变更", 2, ["semantic transfer"]),
    note("link/C.md", "link-C", "盆栽土壤", "", "植物培养", 3),
    note("link/D.md", "link-D", "古典音乐", "", "巴洛克作品", 4),
    note("link/E.md", "link-E", "仓储容量", "", "冷库扩容", 5, [], ["link/F.md"]),
    note("link/F.md", "link-F", "司法培训", "", "案例学习", 6, [], ["link/E.md"]),
  ];
  corpus.push(...linkNotes);
  corpus.push(note("derived.md", "derived", "Derived", "", "", 8, [], ["link/E.md"], true));
  const reverseLinks = new Map();
  for (const item of corpus.filter((candidate) => !candidate.isMergeNote)) {
    for (const target of item.outLinks) reverseLinks.set(target, [...(reverseLinks.get(target) || []), item.path]);
  }
  for (const item of corpus.filter((candidate) => !candidate.isMergeNote)) item.inLinks = reverseLinks.get(item.path) || [];
  for (const item of corpus) item.outLinks = [...new Set([...item.outLinks, "all-notes-index.md"] )];
  for (const item of corpus) item.inLinkOutDegrees = Object.fromEntries(item.inLinks.map((source) => [source, corpus.find((candidate) => candidate.path === source)?.outLinks.length || 0]));
  const shortNoteQuery = note("topic/source.md", "source", "AI视频制作-分镜坐标系规范", "coordinate system design", "Video production notes", 12);
  const sparseQuery = note("sparse/query.md", "sparse-query", "quantum lattice superconducting boundary phase transition eigenvalue spectrum", "", "", 13);
  const sparseCandidate = note("sparse/candidate.md", "sparse-candidate", "garden", "", "quantum", 14);
  return { corpus, goldGroups, linkPaths: linkNotes.map((item) => item.path), shortNotePath, shortNoteQuery, boilerplatePaths, sparseQuery, sparseCorpus: [sparseQuery, sparseCandidate] };
}
