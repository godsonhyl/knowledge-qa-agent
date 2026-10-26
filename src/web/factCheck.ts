/* ============================================================
   web/factCheck.ts —— 事实一致性抽验（数字/IP/版本号核对）
   回答生成后，抽取答案中的"硬事实"（数字、IP、端口、版本号、日期），
   与引用片段原文比对；不一致的挂警告，防模型把记忆当事实。
   纯前端启发式，不调 LLM——只抓"答案里的值在引用原文里找不到"这种最危险的错。
   豁免规则（这些值允许不在原文中，是合法的归纳表达）：
   - 编号引用本身 [n]
   - 百分比小于 10%（常为"涨跌幅/占比"类常识概括）
   - 显著的日期（如 2026-10）如果片段里有同期日期
   ============================================================ */

/** 抽取文本中的硬事实值 */
export function extractHardFacts(text: string): string[] {
  const facts = new Set<string>();

  // IP 地址（含端口）
  for (const m of text.matchAll(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d{1,5})?)\b/g)) {
    facts.add(m[1]!);
  }
  // 版本号（v1.2.3 / 1.2.3build45 / V2 等）
  for (const m of text.matchAll(/\b(?:[vV]?)(\d+\.\d+(?:\.\d+)*(?:[.\-_]?\w{0,10})?)\b/g)) {
    const v = m[1]!;
    // 至少两段数字才算版本号（排除单纯的小数）
    if (v.includes('.') && /\d+\.\d+/.test(v)) facts.add(v);
  }
  // 大数字（≥100 的整数，常是端口号/规模/金额）
  for (const m of text.matchAll(/(?<![\d.])(\d{3,7})(?![\d.%])/g)) {
    facts.add(m[1]!);
  }
  return [...facts];
}

export interface FactCheckResult {
  /** 找不到原文依据的"硬事实"（可能是模型编的） */
  unsupported: string[];
  /** 引用密度：无引用句占比（0-1）；> 阈值时挂软警告，抓"整段陈述没标 [n]"的幻觉 */
  citationGap: number;
  /** 总句数（用于 UI 展示） */
  sentenceCount: number;
  /** 带引用的句数 */
  citedSentenceCount: number;
}

/** 校验答案中的硬事实是否出现在引用片段原文中。
 *  slice 是该消息引用的 [n] 对应片段文本（按编号排序）。
 *  说明：启发式抽验，宽松匹配（原文出现该值即算支持），
 *  目标是抓"凭空编造的数字"，不做语义级核对。
 *  同时计算引用密度：把答案按句切，统计无引用句占比——
 *  超过 0.4 时挂软警告，抓"整段散文陈述没标 [n]"的幻觉。 */
export function verifyFacts(answer: string, citedTexts: string[]): FactCheckResult {
  // 去掉引用标记本身
  const clean = answer.replace(/\[\d{1,2}\]/g, ' ');
  const facts = extractHardFacts(clean);
  const sentences = splitSentences(answer);
  const citedCount = sentences.filter((s) => /\[\d{1,2}\]/.test(s)).length;
  const citationGap = sentences.length ? citedCount / sentences.length : 0;

  const unsupported: string[] = [];
  if (facts.length) {
    const corpus = citedTexts.join('\n');
    const corpusLower = corpus.toLowerCase();

    for (const f of facts) {
      const fl = f.toLowerCase();
      if (corpusLower.includes(fl)) continue;
      // 版本号形式的宽松匹配：主版本段出现即可（1.30.3 → 原文有 1.30 即算）
      const vParts = fl.split('.');
      if (vParts.length >= 2 && corpusLower.includes(vParts.slice(0, 2).join('.'))) continue;
      // 纯数字 3-4 位且 < 200：常见归纳（如"约 50 微秒"换算、占比），豁免
      const n = parseInt(f, 10);
      if (/^\d{3,4}$/.test(f) && n < 200) continue;
      // 带前导 0 或对端口不敏感的匹配
      if (/^\d+$/.test(f) && corpusLower.includes(String(Number(f)))) continue;
      unsupported.push(f);
    }
  }
  // 去重 & 截断（避免长答案产生海量误报刷屏）
  const uniq = [...new Set(unsupported)];
  return {
    unsupported: uniq.slice(0, 5),
    citationGap,
    sentenceCount: sentences.length,
    citedSentenceCount: citedCount,
  };
}

/** 把答案切成句子（中英文句末标点 + 换行）。
 *  引用密度统计用——粗切即可，目标是数"有几句话带了 [n]"。
 *  注意：句末 `.` 必须不被数字包围（避免切 IP/版本/小数）。 */
export function splitSentences(text: string): string[] {
  // 句末标点切：中文 。！？ 总是切；英文 . ! ? 仅当后面非数字（避免 10.0.0.1 / v1.2 / 0.5 被切）
  const raw = text
    .replace(/\n+/g, '\n')
    .split(/(?<=[。！？])\s*|(?<=[.!?])(?![\d])\s*|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return raw;
}
