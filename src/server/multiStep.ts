/* ============================================================
   server/multiStep.ts —— 复杂问题多步检索
   问题分类 → 必要时拆子问题 → 各子问题独立 hybridSearch →
   合并去重证据 → 重新编号 → 喂 LLM 综合作答。
   对简单问题走 fast path（不拆），复杂问题才走多步。
   全程串行化（走 kbIndex 队列），失败退回单路检索。
   ============================================================ */
import { llmReady } from './env.js';
import type { Hit, SearchResult } from '@shared/types.js';

const CLASSIFY_TIMEOUT_MS = 2500;

const CLASSIFY_SYSTEM = `你是一个问题分类器。判断用户问题是否为「复合问题」——即需要拆成多个子问题分别检索后才能完整回答的问题。

判断标准：
- 询问"两个对象的差异/对比"（如 "A 和 B 的部署有什么不同"）→ 复合
- 询问多个不相关主体（"X、Y、Z 分别是什么"）→ 复合
- 询问"流程/步骤"涉及多个阶段 → 复合
- 单一主体、单一事实查询 → 简单

只输出 JSON：{"complex": true, "subQuestions": ["子问题1","子问题2", ...]}（简单问题 subQuestions 为空数组）。不要任何额外文字。`;

interface ClassifyResult {
  complex: boolean;
  subQuestions: string[];
}

/** 调 LLM 判定问题是否复合并拆分。失败/超时返回 {complex:false, subQuestions:[]} */
export async function classifyQuestion(question: string): Promise<ClassifyResult> {
  if (!llmReady()) return { complex: false, subQuestions: [] };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CLASSIFY_TIMEOUT_MS);
  try {
    const res = await fetch(`${process.env.LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.LLM_API_KEY ? { Authorization: `Bearer ${process.env.LLM_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: process.env.LLM_MODEL,
        messages: [
          { role: 'system', content: CLASSIFY_SYSTEM },
          { role: 'user', content: question },
        ],
        temperature: 0.1,
        max_tokens: 2000,  // reasoning 模型兼容：reasoning 占 tokens，太小会掐掉 content
        stream: false,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { complex: false, subQuestions: [] };
    const data: any = await res.json().catch(() => null);
    const content: string = data?.choices?.[0]?.message?.content || '';
    // 提取 JSON（容错：模型可能包 ```json ... ```）
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) return { complex: false, subQuestions: [] };
    const parsed = JSON.parse(m[0]);
    return {
      complex: Boolean(parsed.complex),
      subQuestions: Array.isArray(parsed.subQuestions)
        ? parsed.subQuestions.filter((s: any) => typeof s === 'string' && s.trim()).slice(0, 4)
        : [],
    };
  } catch {
    return { complex: false, subQuestions: [] };
  } finally {
    clearTimeout(timer);
  }
}

/** 按 docId 去重合并多次检索的 hits，重新编号（编号按合并顺序 1,2,3...） */
export function mergeHits(allResults: SearchResult[]): { hits: Hit[]; per: number[] } {
  const seen = new Map<string, Hit>();
  const per: number[] = [];
  for (const r of allResults) {
    const before = per.reduce((a, b) => a + b, 0);
    let added = 0;
    for (const h of r.hits) {
      if (!seen.has(h.chunkId)) {
        seen.set(h.chunkId, { ...h, rel: h.rel });
        added++;
      }
    }
    per.push(before + added);
  }
  const merged = [...seen.values()];
  // 重新编号：hitCount / 引用编号
  merged.forEach((h, i) => {
    h.rel = i + 1 <= merged.length ? (h.rel ?? 0) : h.rel;
  });
  return { hits: merged, per };
}
