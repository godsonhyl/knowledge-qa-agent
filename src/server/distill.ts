/* ============================================================
   server/distill.ts —— 单块 LLM 蒸馏
   ============================================================ */
import { ENV, llmReady } from './env.js';
import { setChunkSummary, listChunks, KbError } from './kbStore.js';
import { chunkIdFor } from './ids.js';
import { kbIndex } from './kbIndex.js';
import type { ChunkPayload } from './kbStore.js';

export const DISTILL_SYSTEM_PROMPT =
  '你是技术文档知识蒸馏器。把给定的文档片段提炼成 2-4 句知识点，覆盖它讲了什么核心概念/术语/结论，用与原文不同的措辞复述（便于按概念检索），但不得引入原文没有的事实。输出纯文本，不要标题、不要列表符号、不要引用编号、不要「本片段」「该块」这类元描述。';

export async function distillChunkInto(docId: string, index: number, chunk: ChunkPayload): Promise<string> {
  if (!llmReady()) throw new KbError(503, '服务端未配置大模型');

  const userPrompt = `【文档】${chunk.docName}\n【章节】${chunk.section || '（无）'}\n【片段正文】\n${chunk.text}\n\n请输出该片段的知识点。`;

  const res = await fetch(`${ENV.LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(ENV.LLM_API_KEY ? { Authorization: `Bearer ${ENV.LLM_API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: ENV.LLM_MODEL,
      stream: false,
      temperature: 0.2,
      max_tokens: 500,
      messages: [
        { role: 'system', content: DISTILL_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`大模型返回 ${res.status}：${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  let summary = String(data.choices?.[0]?.message?.content || '').trim();
  if (!summary) throw new Error('模型没有返回内容');
  if (summary.length > 1000) summary = summary.slice(0, 1000);

  const updated = await setChunkSummary(docId, index, summary);
  if (!updated) throw new Error('写入知识点失败');
  kbIndex.updateChunk(chunkIdFor(docId, index), chunk.text, summary, chunk.docName);
  return summary;
}

export async function distillWholeDoc(docId: string): Promise<{ distilled: number; failed: number }> {
  const chunks = await listChunks(docId);
  if (!chunks) throw new KbError(404, '文档不存在');
  let distilled = 0;
  let failed = 0;
  for (const c of chunks) {
    if (c.summary && c.summary.trim()) { distilled++; continue; }
    try {
      await distillChunkInto(docId, c.index, c);
      distilled++;
    } catch {
      failed++;
    }
  }
  return { distilled, failed };
}
