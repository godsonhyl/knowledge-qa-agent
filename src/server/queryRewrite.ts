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
5. 不超过 3 个变体。
6. 若提供了「对话历史」，且当前问题含指代词（它/这个/那/上面提到的），先用历史把指代解析成明确实体再改写——指代未解析的问题无法在知识库里检索到。`;

/** 对话历史条目（queryRewrite 用来解析指代） */
export interface HistoryTurn {
  question: string;
  answer: string;
}

/** 调 LLM 生成查询变体。失败时返回 [question]。
 *  opts.history：对话历史——若当前问题含指代词，先用历史解析成明确实体再改写。 */
export async function rewriteQuery(
  question: string,
  _opts: { sensitivity?: number; history?: HistoryTurn[] } = {},
): Promise<string[]> {
  if (!llmReady()) return withSynonyms(question);
  // 短问题（< 6 字）直接用词典扩展，不浪费 LLM 调用；
  // 但含指代词的短问题（"它的基差"）若给了历史，仍需 LLM 解析
  const hasAnaphora = /\b(它|他|这个|那个|上面|之前|那|这)\b/.test(question) || /(它|他|这|那|上面|之前)/.test(question);
  if (question.length < 6 && !(_opts.history?.length && hasAnaphora)) return withSynonyms(question);

  // 构造含历史的 user prompt（指代解析）
  let userContent = question;
  if (_opts.history?.length) {
    const hist = _opts.history.slice(-3).map((h, i) =>
      `Q${i + 1}: ${h.question}\nA${i + 1}: ${h.answer}`).join('\n');
    userContent = `【对话历史】\n${hist}\n\n【当前问题】\n${question}\n\n请基于历史解析当前问题中的指代（如有），再输出检索变体。`;
  }

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
          { role: 'user', content: userContent },
        ],
        temperature: 0.3,
        max_tokens: 2000,  // deepseek 系 reasoning 模型：reasoning 消耗 tokens，120 会掐掉 content
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
    // 去重 + 原问题一定在内（保证主路径召回不变）；
    // 但若历史解析出了明确实体（变体比原问题更具体），把解析后的变体也纳入
    const out = new Set<string>([question.toLowerCase()]);
    const result = [question];
    for (const v of variants) {
      if (!out.has(v.toLowerCase()) && v.toLowerCase() !== question.toLowerCase()) {
        out.add(v.toLowerCase());
        result.push(v);
      }
    }
    return withSynonyms(question).concat(result.slice(1)).slice(0, 4);
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
