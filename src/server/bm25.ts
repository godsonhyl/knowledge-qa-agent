/* ============================================================
   server/bm25.ts —— 分词、BM25 索引、连续段提取
   从 retrieval.js 逐行移植：阈值与分词语义是 §4/§5 检索契约。
   ============================================================ */

const STOPWORDS = new Set([
  '的', '了', '是', '在', '和', '与', '及', '或', '也', '就', '都', '而', '很',
  '有', '无', '被', '把', '给', '让', '对', '从', '到', '为', '以', '于', '中',
  '上', '下', '里', '外', '这', '那', '哪', '什么', '怎么', '如何', '吗', '呢',
  '吧', '啊', '我', '你', '他', '她', '它', '们', '个', '之', '其', '并', '但',
  '不', '没', '要', '会', '能', '可', '可以', '请问', '一下', '一个', '关于',
  'the', 'a', 'an', 'of', 'to', 'in', 'is', 'are', 'was', 'and', 'or', 'for',
  'on', 'with', 'as', 'at', 'by', 'be', 'this', 'that', 'it', 'from',
]);

const CJK_RE = /[一-鿿㐀-䶿]/;

/**
 * 分词。
 * unigram：用于索引膨胀，提升召回
 * bigram / latin：作为「强信号词」，用于打分与依据判定
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const s = String(text).toLowerCase();
  const tokens: string[] = [];

  const words = s.match(/[a-z][a-z0-9_+#.-]*|\d+(?:\.\d+)?/g);
  if (words) {
    for (const w of words) {
      if (w.length >= 2 && !STOPWORDS.has(w)) tokens.push(w);
    }
  }

  const cjkRuns = s.match(/[一-鿿㐀-䶿]+/g);
  if (cjkRuns) {
    for (const run of cjkRuns) {
      const chars = Array.from(run);
      for (let i = 0; i < chars.length; i++) {
        const c = chars[i]!;
        if (!STOPWORDS.has(c)) tokens.push(c);
        if (i + 1 < chars.length) {
          const a = chars[i]!;
          const b = chars[i + 1]!;
          // 两侧都不是停用词才保留 bigram，滤掉「查怎」「的典」这类跨词界噪声
          if (!STOPWORDS.has(a) && !STOPWORDS.has(b)) tokens.push(a + b);
        }
      }
    }
  }

  return tokens;
}

/** 强信号词：中文 bigram + 拉丁词。这些才参与打分与判定，unigram 只用于召回 */
export function strongTokens(text: string): string[] {
  return tokenize(text).filter((t) => (t.length === 2 && CJK_RE.test(t)) || (!CJK_RE.test(t) && t.length >= 2));
}

/**
 * 从 query 中提取「连续段」集合，用于 phraseHit 判定。
 * 连续段 = query 原文 CJK 串里相邻的 strong bigram 对（如「机器」「器人」相邻 → {机器/器人}），
 * 或单条拉丁术语（长度 ≥ 3，如 reserve、price）。
 * 返回 Set<string>：中文段为「bigram1/bigram2」键；拉丁术语为原词。
 * 判定方：某片段若同时命中段内全部 token，记一次 phraseHit。
 */
function isStopCjk(c: string): boolean {
  return STOPWORDS.has(c);
}

export function buildQueryPhrases(query: string, qStrong: string[]): Set<string> {
  const strongSet = new Set(qStrong);
  const phrases = new Set<string>();

  // CJK：扫描 query 原文每个连续 CJK 串，按字符顺序看相邻 strong bigram 是否成链
  const cjkRuns = String(query || '').toLowerCase().match(/[一-鿿㐀-䶿]+/g) || [];
  for (const run of cjkRuns) {
    const chars = Array.from(run);
    const present: { tok: string; start: number }[] = [];
    for (let i = 0; i + 1 < chars.length; i++) {
      const a = chars[i]!;
      const b = chars[i + 1]!;
      if (isStopCjk(a) || isStopCjk(b)) continue;
      const tok = a + b;
      if (!strongSet.has(tok)) continue;   // 被泛用词过滤掉的视为不在强信号里
      present.push({ tok, start: i });
    }
    // 相邻 strong bigram（start 差 1）成对成段
    for (let i = 0; i + 1 < present.length; i++) {
      const p1 = present[i]!;
      const p2 = present[i + 1]!;
      if (p2.start - p1.start === 1) {
        phrases.add(`${p1.tok}/${p2.tok}`);
      }
    }
  }

  // 拉丁术语：长度 ≥ 3 的拉丁强信号词单独算一个段
  for (const t of qStrong) {
    if (!CJK_RE.test(t) && t.length >= 3) phrases.add(t);
  }

  return phrases;
}

/* ---------------- BM25 索引 ---------------- */

export interface IndexedChunk {
  chunkId: string;
  text: string;
  summary: string | null;
  /** 定位元数据透传（hybrid 命中时用于构造 Hit；词法检索本身不使用） */
  docId?: string;
  docName?: string;
  section?: string;
  startLine?: number;
  endLine?: number;
  startChar?: number;
  endChar?: number;
  source?: string;
  addedAt?: number;
}

interface IndexDoc {
  chunk: IndexedChunk;
  len: number;
  tf: Map<string, number>;
}

export class BM25Index {
  k1: number;
  b: number;
  docs: IndexDoc[] = [];
  df = new Map<string, number>();
  avgLen = 1;

  constructor(k1 = 1.5, b = 0.72) {
    this.k1 = k1;
    this.b = b;
  }

  build(chunks: IndexedChunk[]): this {
    this.docs = [];
    this.df = new Map();
    let lenSum = 0;

    for (const chunk of chunks) {
      // 索引用全量 token（含 unigram，保证召回）。
      // 若该块已蒸馏出知识点，把知识点拼进来一起索引——概念词也能被命中。
      // 文档名也拼进索引：文档名常含关键术语（如「TL-衍生品交易系统-准备上线评估」），
      // 不拼进来则按正文匹配会漏掉文档名线索，宽泛问题召回质量差。
      const docName = chunk.docName ? `${chunk.docName}\n` : '';
      const textForIndex = `${docName}${chunk.text}${chunk.summary ? '\n' + chunk.summary : ''}`;
      const tokens = tokenize(textForIndex);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
      lenSum += tokens.length || 1;
      this.docs.push({ chunk, len: tokens.length || 1, tf });
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
    }
    this.avgLen = this.docs.length ? lenSum / this.docs.length : 1;
    return this;
  }

  get N(): number {
    return this.docs.length;
  }

  /** 用给定权重表打分（只统计表里出现过的词） */
  score(tf: Map<string, number>, len: number, weights: Map<string, number>): number {
    let s = 0;
    const N = this.N || 1;
    for (const [t, w] of weights) {
      const f = tf.get(t);
      if (!f) continue;
      const n = this.df.get(t) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      s += w * idf * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * len) / this.avgLen)));
    }
    return s;
  }
}

export { CJK_RE };
