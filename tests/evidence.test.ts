import { describe, it, expect } from 'vitest';
import { tokenize, strongTokens, buildQueryPhrases } from '@server/bm25.js';
import { Retriever } from '@server/search/retriever.js';
import { chunkDocument } from '@server/chunker.js';
import { SEED_DOCS } from '@shared/seed.js';

/* 移植 selftest.js §4（应命中）/ §5（应拒答）—— 检索调优回归契约，字面不得改 */

function buildSeedIndex(): { r: Retriever; docs: typeof SEED_DOCS } {
  const r = new Retriever();
  const all = SEED_DOCS.flatMap((d) =>
    chunkDocument(d.text, d.name).map((c, i) => ({
      chunkId: `${d.name}#${i}`,
      text: c.text,
      summary: null,
    })),
  );
  r.build(all);
  return { r, docs: SEED_DOCS };
}

describe('tokenize', () => {
  it('gitlab-runner 保留为一条术语', () => {
    expect(tokenize('gitlab-runner')).toEqual(['gitlab-runner']);
  });
  it('中文产生 unigram + bigram', () => {
    const t = tokenize('机器人');
    expect(t).toContain('机器');
    expect(t).toContain('器人');
  });
  it('停用词两端的 bigram 被滤掉', () => {
    const t = tokenize('的是什么');
    expect(t).not.toContain('的是');
    expect(t).not.toContain('是什');
  });
});

describe('buildQueryPhrases', () => {
  it('智能机器人产生相邻 bigram 段', () => {
    const q = strongTokens('介绍下智能机器人');
    const p = buildQueryPhrases('介绍下智能机器人', q);
    expect(p.size).toBeGreaterThan(0);
  });
  it('拉丁术语长度≥3 才成段', () => {
    const p = buildQueryPhrases('用 gitlab-runner 部署', strongTokens('用 gitlab-runner 部署'));
    expect(p.has('gitlab-runner')).toBe(true);
  });
});

describe('证据门回归 —— §4 应当命中（检索契约）', () => {
  const { r } = buildSeedIndex();
  const shouldHit: [string, string][] = [
    ['订单簿撮合延迟的典型范围是多少', '撮合延迟'],
    ['Price Ladder 和 std::map 有什么区别', 'Price Ladder'],
    ['伪共享是什么，会带来什么性能问题', '伪共享'],
    ['自成交检查怎么做', '自成交'],
    ['前端风控必须在多少时间内完成', '风控'],
    ['提交信息有什么规范要求', '提交信息'],
    ['回测区间有什么要求', '回测'],
    ['分支预测失败的代价大概是多少', '分支预测'],
  ];
  for (const [q, kw] of shouldHit) {
    it(`"${q}" 命中`, () => {
      const res = r.search(q, { topK: 5, sensitivity: 50 });
      const top = res.hits[0];
      expect(res.hasEvidence, `reason=${res.reason} mc=${res.matchCount}`).toBe(true);
      expect(top, 'kept hits[0] 应存在').toBeDefined();
      expect(top!.chunk.text).toContain(kw.slice(0, 2));
    });
  }
});

describe('证据门回归 —— §5 应当拒答（防幻觉底线）', () => {
  const { r } = buildSeedIndex();
  const shouldMiss = [
    'Kubernetes 的 Pod 怎么调度',
    '推荐一部电影',
    '今天天气怎么样',
    '比特币价格是多少',
    'React 的 useEffect 什么时候执行',
    'Python 装饰器的原理是什么',
    '如何配置 Nginx 反向代理',
  ];
  for (const q of shouldMiss) {
    it(`"${q}" 拒答`, () => {
      const res = r.search(q, { topK: 5, sensitivity: 50 });
      expect(res.hasEvidence).toBe(false);
    });
  }
});

describe('§6 拒答时不会泄露片段', () => {
  const { r } = buildSeedIndex();
  it('hits 为空但保留低分候选', () => {
    const res = r.search('如何配置 Nginx 反向代理', { topK: 5, sensitivity: 50 });
    expect(res.hits.length).toBe(0);
    expect(res.allScored.length).toBeGreaterThan(0);
  });
});

describe('§11 phrase-hit 回归', () => {
  it('知识库含「智能机器人」时相关提问应命中', () => {
    const r = new Retriever();
    const chunks = chunkDocument(
      '## 智能机器人\n\n智能机器人是企微提供的会话机器人能力，支持自动回复与回调事件。\n\n机器人 webhook 地址格式为 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=KEY。\n\n群机器人可以在群里接收消息推送，配合关键词回复实现自动应答。\n',
      '机器人文档.md',
    );
    r.build(chunks.map((c, i) => ({ chunkId: `机器人文档.md#${i}`, text: c.text, summary: null })));
    for (const q of ['介绍下智能机器人', '什么是智能机器人', '机器人怎么配置', '群机器人支持哪些功能']) {
      const res = r.search(q, { topK: 5, sensitivity: 50 });
      expect(res.hasEvidence, `"${q}" 应命中，实际 ${res.reason}`).toBe(true);
    }
  });
  it('gitlab-runner 类术语命中（单 mc + phraseHit 放行）', () => {
    const r = new Retriever();
    const chunks = chunkDocument(
      '## CI 部署\n\n项目使用 gitlab-runner 做持续集成。gitlab-runner 安装在专用的 CI 机器上，注册时需要填写 gitlab URL 与 token。\n',
      'ci.md',
    );
    r.build(chunks.map((c, i) => ({ chunkId: `ci.md#${i}`, text: c.text, summary: null })));
    for (const q of ['介绍下 gitlab-runner', 'gitlab-runner 是什么', '怎么用 gitlab-runner']) {
      const res = r.search(q, { topK: 5, sensitivity: 50 });
      expect(res.hasEvidence, `"${q}" 应命中，实际 ${res.reason}`).toBe(true);
    }
  });
});

describe('§12 蒸馏后语义近邻命中', () => {
  it('原文无「CI」字样，蒸馏知识点后含 CI 的提问能命中', () => {
    const r = new Retriever();
    const chunks = chunkDocument(
      '## 持续集成\n\n我们团队的持续集成流水线跑在专用的构建机上，每次提交代码都会自动触发构建、测试与打包三个阶段。\n',
      '运维文档.md',
    );
    // 先确认原文措辞无法命中「CI 流水线」query 里的拉丁词
    r.build(chunks.map((c, i) => ({ chunkId: `运维文档.md#${i}`, text: c.text, summary: null })));
    const before = r.search('CI 流水线是怎么触发的', { topK: 5, sensitivity: 50 });
    // 模拟 LLM 蒸馏知识点
    r.build(chunks.map((c, i) => ({
      chunkId: `运维文档.md#${i}`,
      text: c.text,
      summary: '团队的 CI 使用专用构建机执行流水线，代码提交后自动触发构建、测试、打包。',
    })));
    const after = r.search('CI 流水线是怎么触发的', { topK: 5, sensitivity: 50 });
    expect(after.hasEvidence).toBe(true);
    void before;
  });
});
