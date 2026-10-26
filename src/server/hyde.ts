/* ============================================================
   server/hyde.ts —— HyDE 假设文档嵌入（Hybrid 검색의 보조 보강）
   HyDE（Hypothetical Document Embedding）：向量检索前先让 LLM 生成一段
   假设答案，用假设答案嵌入做向量检索——假设答案的措辞更接近文档，
   召回词面差异大但语义近的 chunk（如问"自成交怎么检查"召回"违规交易监测流程"）。
   失败/未配置 → 静默返回 null，主路径沿用原问题嵌入；不改阈值不破坏 §4/§5。
   单次额外 LLM 调用（max_tokens=200，2.5s 超时）+ 一次嵌入。
   ============================================================ */
import { ENV, llmReady } from './env.js';

const HYDE_TIMEOUT_MS = 2500;
const HYDE_MAX_TOKENS = 200;

/** 让 LLM 生成一段简短的假设答案（不展示给用户，仅用于向量检索）。
 *  prompt 约束：2-4 句、用与文档接近的措辞、不要求事实准确（只追求词面接近）。
 *  返回 null 表示未启用/失败/超时——主路径沿用原问题嵌入。 */
export async function generateHypothesis(question: string): Promise<string | null> {
  if (!llmReady() || !ENV.HYDE_ENABLED) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HYDE_TIMEOUT_MS);
  try {
    const res = await fetch(`${ENV.LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(ENV.LLM_API_KEY ? { Authorization: `Bearer ${ENV.LLM_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: ENV.LLM_MODEL,
        stream: false,
        temperature: 0.3,
        max_tokens: HYDE_MAX_TOKENS,
        messages: [
          {
            role: 'system',
            content: '你是一个文档检索辅助模块。给定一个问题，请用 2-4 句话写一段"假设该问题在文档中的答案"，用与正式技术文档接近的措辞（名词、术语、陈述句）。不要解释、不要寒暄、不要说"假设"或"可能"，直接像在写文档正文一样写。目标是让这段文字的词面与真实文档接近，便于向量检索召回。',
          },
          { role: 'user', content: question },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data: any = await res.json().catch(() => null);
    const text = String(data?.choices?.[0]?.message?.content || '').trim();
    // 过短或异常输出不算
    return text.length >= 20 ? text.slice(0, 600) : null;
  } catch {
    return null;  // 超时/网络失败静默降级
  } finally {
    clearTimeout(timer);
  }
}
