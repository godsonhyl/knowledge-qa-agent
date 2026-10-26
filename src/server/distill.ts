/* ============================================================
   server/distill.ts —— 单块 LLM 蒸馏
   ============================================================ */
import { ENV, llmReady } from './env.js';
import { setChunkSummary, listChunks, KbError } from './kbStore.js';
import { chunkIdFor } from './ids.js';
import { kbIndex } from './kbIndex.js';
import { invalidateRerankCache } from './rerank.js';
import type { ChunkPayload } from './kbStore.js';

export const DISTILL_SYSTEM_PROMPT =
  '你是技术文档知识蒸馏器。把给定的文档片段提炼成 2-4 句知识点，覆盖它讲了什么核心概念/术语/结论，用与原文不同的措辞复述（便于按概念检索），但不得引入原文没有的事实。输出纯文本，不要标题、不要列表符号、不要引用编号、不要「本片段」「该块」这类元描述。';

/** 表格感知蒸馏 prompt：当片段含 markdown 表格 / GFM 表格行时，要求保留表格结构
 *  ——「提取关键字段」而非「概括成散文」，避免表格被压扁丢结构。 */
export const DISTILL_TABLE_SYSTEM_PROMPT =
  '你是技术文档知识蒸馏器。本片段包含表格数据。请提取表格的关键字段与取值，保留 markdown 表格结构（| 列 | 列 | 格式）输出，便于按字段检索。若表格行数较多，可只保留最关键的若干行并说明省略了什么；不得引入原文没有的事实。输出 markdown，不要标题、不要引用编号、不要「本片段」「该块」这类元描述。';

/** 检测片段是否含表格（GFM `|` 行 或 `<table>`）——表格块改用保形 prompt */
export function isTableChunk(text: string): boolean {
  // GFM 表格：至少 2 行 | + 一行分隔符（|---|）
  const lines = text.split('\n').filter((l) => l.trim());
  let pipeRows = 0;
  let hasSep = false;
  for (const l of lines) {
    if (/^\s*\|.*\|\s*$/.test(l)) {
      pipeRows++;
      if (/^\s*\|?[\s:|-]+\|?\s*$/.test(l) && l.includes('-')) hasSep = true;
    }
  }
  if (pipeRows >= 2 && hasSep) return true;
  // HTML 表格
  if (/<table[\s>]/i.test(text) && /<\/table>/i.test(text)) return true;
  return false;
}

export async function distillChunkInto(docId: string, index: number, chunk: ChunkPayload): Promise<string> {
  if (!llmReady()) throw new KbError(503, '服务端未配置大模型');

  // 表格块用保形 prompt（保留 | 列 | 结构），其余用概括 prompt
  const sysPrompt = isTableChunk(chunk.text) ? DISTILL_TABLE_SYSTEM_PROMPT : DISTILL_SYSTEM_PROMPT;
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
        { role: 'system', content: sysPrompt },
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
  // 蒸馏改变了 text+summary 的检索表征 → rerank 缓存排序可能失效，清掉
  invalidateRerankCache();
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
