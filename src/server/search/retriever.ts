/* ============================================================
   server/search/retriever.ts —— 词法检索 + 证据判定
   从 retrieval.js 逐行移植。阈值 3−1.2s / 0.62−0.22s / 8−4.5s 是
   §4（应命中 8 条）/§5（应拒答 7 条）回归契约，不得改动。
   ============================================================ */
import { BM25Index, CJK_RE, buildQueryPhrases, strongTokens, type IndexedChunk } from '../bm25.js';

export interface LexHit {
  chunk: IndexedChunk;
  score: number;
  matchedTerms: string[];
  matchCount: number;
  rarity: number;
  phraseHit: number;
  rel: number;
}

export interface LexResult {
  hits: LexHit[];          // 有依据时保留的命中（kept）
  allScored: LexHit[];     // 全部候选（拒答时 UI 仍展示）
  hasEvidence: boolean;
  reason: string;
  coverage: number;
  matchCount: number;
  termHits: number;
  rarity: number;
  phraseHit: number;
  topScore: number;
  terms: string[];
}

export class Retriever {
  index: BM25Index | null = null;

  build(chunks: IndexedChunk[]): number {
    this.index = new BM25Index().build(chunks);
    return this.index.N;
  }

  search(query: string, opts: { topK?: number; sensitivity?: number } = {}): LexResult {
    const topK = opts.topK || 5;
    const sensitivity = typeof opts.sensitivity === 'number' ? opts.sensitivity : 50;

    if (!this.index || this.index.N === 0) {
      return { hits: [], allScored: [], hasEvidence: false, reason: 'empty-kb', coverage: 0, matchCount: 0, termHits: 0, rarity: 0, phraseHit: 0, topScore: 0, terms: [] };
    }

    // ---- 动态停用词：按语料 df 剔除「泛用词」 ----
    const index = this.index;
    const N = index.N;
    const dfCount = (t: string) => index.df.get(t) || 0;
    const GENERIC_RATIO = N <= 40 ? 0.28 : N <= 120 ? 0.2 : 0.16;
    const GENERIC_MIN = N <= 40 ? 3 : N <= 120 ? 6 : 10;

    const allStrong = strongTokens(query);
    if (!allStrong.length) {
      return { hits: [], allScored: [], hasEvidence: false, reason: 'empty-query', coverage: 0, matchCount: 0, termHits: 0, rarity: 0, phraseHit: 0, topScore: 0, terms: [] };
    }

    const qStrong = allStrong.filter(
      (t) => !(dfCount(t) / N >= GENERIC_RATIO && dfCount(t) >= GENERIC_MIN),
    );

    // 全被过滤掉时退回全量，判定会因命中数不足而更保守
    const effective = qStrong.length ? qStrong : allStrong;

    const weights = new Map<string, number>();
    for (const t of effective) weights.set(t, (weights.get(t) || 0) + 1);

    const phrases = buildQueryPhrases(query, effective);
    return this.rank(weights, effective, sensitivity, topK, phrases);
  }

  rank(weights: Map<string, number>, qStrong: string[], sensitivity: number, topK: number, phrases: Set<string>): LexResult {
    const index = this.index!;
    const strongSet = new Set(qStrong);
    const N = index.N || 1;
    const dfCount = (t: string) => index.df.get(t) || 0;

    const scored: { chunk: IndexedChunk; score: number; tf: Map<string, number> }[] = [];
    for (const d of index.docs) {
      const s = index.score(d.tf, d.len, weights);
      if (s > 0) scored.push({ chunk: d.chunk, score: s, tf: d.tf });
    }

    if (!scored.length) {
      return {
        hits: [], allScored: [], hasEvidence: false, reason: 'no-match',
        coverage: 0, matchCount: 0, termHits: 0, rarity: 0, phraseHit: 0, topScore: 0,
        terms: Array.from(strongSet),
      };
    }

    scored.sort((a, b) => b.score - a.score);

    const pool = scored.slice(0, Math.max(topK * 4, 16));
    const hits: LexHit[] = [];
    const globalMatched = new Set<string>();

    for (const s of pool) {
      const matched: string[] = [];
      for (const t of strongSet) {
        if (s.tf.has(t)) {
          matched.push(t);
          globalMatched.add(t);
        }
      }
      // 稀有度 rarity = 1 - df/N（不用 idf：小语料 idf 挤在窄区间失去区分度）
      let rarity = 0;
      for (const t of matched) rarity = Math.max(rarity, 1 - dfCount(t) / N);

      // phraseHit：该片段是否命中 query 里的一个「连续段」
      let phraseHit = 0;
      const matchedSet = new Set(matched);
      for (const p of phrases) {
        if (p.includes('/')) {
          const parts = p.split('/');
          if (parts.every((t) => matchedSet.has(t))) phraseHit++;
        } else if (matchedSet.has(p)) {
          phraseHit++;
        }
      }

      hits.push({
        chunk: s.chunk,
        score: Number(s.score.toFixed(3)),
        matchedTerms: matched,
        matchCount: matched.length,
        rarity: Number(rarity.toFixed(3)),
        phraseHit,
        rel: 0,
      });
      if (hits.length >= topK * 2) break;
    }

    const topScore = scored[0]!.score || 1;
    for (const h of hits) h.rel = Number((h.score / topScore).toFixed(3));

    const top = hits[0];
    const matchCount = top ? top.matchCount : 0;
    const rarity = top ? top.rarity : 0;
    const phraseHit = top ? top.phraseHit : 0;
    const coverage = strongSet.size ? Number((globalMatched.size / strongSet.size).toFixed(3)) : 0;

    // ---- 依据判定 ----
    let termHits = 0;
    for (const h of hits.slice(0, 3)) {
      for (const t of h.matchedTerms) {
        if (!CJK_RE.test(t)) termHits++;
      }
    }

    const s = sensitivity / 100;
    const needMatches = 3 - s * 1.2;            // 3.0 → 1.8
    const needRarity = 0.62 - s * 0.22;         // 0.62 → 0.40
    const needScore = 8.0 - s * 4.5;            // 8.0 → 3.5

    let hasEvidence = false;
    let reason = 'no-match';

    if (matchCount === 0) {
      reason = 'no-match';
    } else if (matchCount >= needMatches && topScore >= needScore * 0.7) {
      hasEvidence = true;
      reason = 'matched';
    } else if (termHits >= 1 && rarity >= needRarity) {
      hasEvidence = true;
      reason = 'term-hit';
    } else if (phraseHit >= 1) {
      // 命中了 query 里的一个连续词组（如「智能机器人」或整条术语 gitlab-runner），
      // 连续段被命中本身足以证明语料在讨论这个词。
      hasEvidence = true;
      reason = 'phrase-hit';
    } else if (topScore >= needScore && matchCount >= 2) {
      hasEvidence = true;
      reason = 'high-score';
    } else if (matchCount >= 2 && rarity >= needRarity + 0.2) {
      hasEvidence = true;
      reason = 'distinctive-pair';
    } else if (matchCount < needMatches) {
      reason = 'weak-match';
    } else {
      reason = 'below-threshold';
    }

    const kept = hasEvidence
      ? hits.filter((h) => h.matchCount >= 1 && h.score >= needScore * 0.3).slice(0, topK)
      : [];

    return {
      hits: kept,
      allScored: hits.slice(0, topK),
      hasEvidence,
      reason,
      coverage,
      matchCount,
      termHits,
      rarity,
      phraseHit,
      topScore: Number(topScore.toFixed(2)),
      terms: Array.from(strongSet),
    };
  }
}
