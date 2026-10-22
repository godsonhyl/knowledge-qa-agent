/* ============================================================
   server/queryRewrite.ts —— 查询改写（提升召回）
   用 LLM 把原问题扩展为 2-3 个变体（同义、术语规范化、拆子问题），
   供 hybridSearch 多路检索 + RRF 二次融合。
   阈值不可改；改写只影响"召回广度"，不动证据门判定。
   失败/超时返回 [原问题]——主路径永不阻塞。
   ============================================================ */
import { ENV, llmReady } from './env.js';
import { expandQueryWithSynonyms } from './synonyms.js';

const REWRITE_TIMEOUT_MS = 3500;
const REWRITE_SYSTEM = `你是一个搜索查询改写器。给定用户的问题，输出 2-3 个**检索变体**，用于在企业知识库里做多路召回。
规则：
1. 只输出变体，每行一个，不要编号、不要解释、不要前后空行。
2. 变体要互补：同义改写、术语规范化（口语→术语）、必要时拆成子问题。
3. 必须包含原问题最关键的实体/术语，不要丢关键词。
4. 中文问题输出中文变体，英文问题输出英文。
5. 不超过 3 个变体。`;

/** 调 LLM 生成查询变体。失败时返回 [question]。 */
export async function rewriteQuery(
  question: string,
  _opts: { sensitivity?: number } = {},
): Promise<string[]> {
  if (!llmReady()) return withSynonyms(question);
  // 短问题（< 6 字）直接用词典扩展，不浪费 LLM 调用
  if (question.length < 6) return withSynonyms(question);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REWRITE_TIMEOUT_MS);
  try {
    const res = await fetch(`${ENV.LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(ENV.LLM_API_KEY ? { Authorization: `Bearer ${ENV.LLM_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: ENV.LLM_MODEL,
        messages: [
          { role: 'system', content: REWRITE_SYSTEM },
          { role: 'user', content: question },
        ],
        temperature: 0.3,
        max_tokens: 120,
        stream: false,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return withSynonyms(question);
    const data: any = await res.json().catch(() => null);
    const text: string = data?.choices?.[0]?.message?.content || '';
    const variants = text
      .split('\n')
      .map((l) => l.replace(/^[\s•\-\d.、)]+/, '').trim())
      .filter((l) => l && l.length >= 2 && l.length <= 80)
      .slice(0, 3);
    if (!variants.length) return withSynonyms(question);
    // 去重 + 原问题一定在内（保证主路径召回不变）
    const set = new Set<string>([question, ...variants.map((v) => v.toLowerCase())]);
    const out = [question];
    for (const v of variants) {
      if (!set.has(v.toLowerCase())) continue;
      if (v.toLowerCase() === question.toLowerCase()) continue;
      out.push(v);
    }
    return withSynonyms(question).concat(out).slice(0, 4);
  } catch {
    return withSynonyms(question);
  } finally {
    clearTimeout(timer);
  }
}

/** 同义词组扩展（不走 LLM，词典直接命中）：
 *  "交易主干的主备" → 变体 "交易主干的主备 TL"（canonical 词补入） */
function withSynonyms(question: string): string[] {
  return [question, ...expandQueryWithSynonyms(question)];
}
