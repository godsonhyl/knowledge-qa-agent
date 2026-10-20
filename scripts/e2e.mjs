/**
 * e2e.mjs —— 对运行中的 stack 做端到端验收（移植 selftest §4/§5 + 引用往返）
 * 用法：node scripts/e2e.mjs [baseUrl]
 * 默认 http://localhost:3000
 */
const BASE = process.argv[2] || 'http://localhost:3000';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? '  \x1b[90m' + detail + '\x1b[0m' : ''}`);
  } else {
    fail++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? '  ' + detail : ''}`);
  }
}

async function j(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  return { status: res.status, data };
}

console.log('\n=== E2E 验收 ===');

// 0. config
const cfg = await j('GET', '/api/config');
check('/api/config 可达', cfg.status === 200, JSON.stringify(cfg.data).slice(0, 100));

// 1. 清空 → 种子导入
await j('DELETE', '/api/kb/docs');
const SEED = [
  ['低延迟交易系统知识手册.md', `# 低延迟交易系统知识手册\n\n## 三、撮合与性能指标\n\n### 3.1 撮合延迟\n\n国内交易所的报单到交易所确认的端到端延迟通常在 50 到 200 微秒之间，其中柜台与网关部分占 30 到 80 微秒。\n\n本机内部从收到报文到完成撮合的耗时，典型要求在 10 微秒以内，99 分位（P99）不超过 30 微秒。\n\n### 3.2 常见性能瓶颈\n\n第二类瓶颈是伪共享（false sharing），多线程更新同一缓存行的独立变量会导致性能急剧下降。\n\n## 四、风控规则\n\n### 4.2 自成交检查\n\n自成交检查需要同时比对买卖两侧的账户号与席位号，任一侧相同即判定为潜在自成交并拒单。\n`],
  ['C++ 性能优化实践要点.md', `# C++ 性能优化实践要点\n\n## 三、编译器与分支预测\n\n### 3.1 分支预测失败代价\n\n现代 CPU 的分支预测失败代价约 15 到 20 个时钟周期，是投机执行流水线上的常见瓶颈。\n\n### 2.1 Cache Line 与对齐\n\nx86-64 架构下 cache line 为 64 字节。两个变量落在同一条 cache line 时，不同核的并发写入会互相失效。\n`],
  ['团队协作与交付规范.md', `# 团队协作与交付规范\n\n## 二、测试要求\n\n### 2.2 回测验证\n\n策略类改动必须通过历史行情回测验证，回测区间不少于一年，并包含至少一次大幅波动行情。\n\n### 1.1 提交信息规范\n\n提交信息首行使用祈使句描述变更内容，不超过 50 个字符。\n`],
];
let added = 0;
for (const [name, text] of SEED) {
  const r = await j('POST', '/api/kb/docs', { name, text, source: 'seed' });
  if (r.status === 201) added++;
}
check('导入 3 篇种子文档', added === 3, `added=${added}`);

// 2. §4 应命中
const shouldHit = [
  ['订单簿撮合延迟的典型范围是多少', '撮合'],
  ['伪共享是什么，会带来什么性能问题', '伪共享'],
  ['自成交检查怎么做', '自成交'],
  ['回测区间有什么要求', '回测'],
  ['分支预测失败的代价大概是多少', '分支预测'],
];
for (const [q, kw] of shouldHit) {
  const r = await j('POST', '/api/kb/search', { question: q, topK: 3, sensitivity: 50 });
  const top = r.data?.hits?.[0];
  check(`"${q}" 命中`, r.data?.hasEvidence === true && top?.text?.includes(kw.slice(0, 2)),
    r.data?.hasEvidence ? `→ ${top?.docName} L${top?.startLine}` : `拒绝(${r.data?.reason})`);
}

// 3. §5 应拒答
const shouldMiss = [
  'Kubernetes 的 Pod 怎么调度',
  '推荐一部电影',
  '今天天气怎么样',
  'React 的 useEffect 什么时候执行',
  '如何配置 Nginx 反向代理',
];
for (const q of shouldMiss) {
  const r = await j('POST', '/api/kb/search', { question: q, topK: 3, sensitivity: 50 });
  check(`"${q}" 拒答`, r.data?.hasEvidence === false, `reason=${r.data?.reason}`);
}

// 4. 引用偏移往返
{
  const r = await j('POST', '/api/kb/search', { question: '自成交检查怎么做', topK: 1, sensitivity: 50 });
  const hit = r.data?.hits?.[0];
  check('检索返回带偏移 hit', !!hit && hit.startLine > 0 && hit.endChar > hit.startChar, `L${hit?.startLine}-${hit?.endLine} chars ${hit?.startChar}-${hit?.endChar}`);
  const doc = await j('GET', `/api/kb/docs/${hit.docId}`);
  const text = doc.data?.text || '';
  const norm = (s) => s.replace(/\s+/g, '');
  const head = norm(hit.text).slice(0, 30);
  const byLine = norm(text.split(/\r?\n/).slice(hit.startLine - 1, hit.endLine).join('\n'));
  check('行号定位准确', byLine.includes(head));
  const byChar = norm(text.slice(hit.startChar, hit.startChar + hit.text.length + 40)).slice(0, 30);
  check('字符偏移定位准确', byChar.startsWith(head));
}

// 5. 文档列表 & 统计
const docs = await j('GET', '/api/kb/docs');
check('列表返回 3 篇', docs.data?.docs?.length === 3);
const stats = await j('GET', '/api/kb/stats');
check('统计接口可用', typeof stats.data?.totalChunks === 'number', `chunks=${stats.data?.totalChunks}`);

// 6. 重名导入 409
{
  const r = await j('POST', '/api/kb/docs', { name: SEED[0][0], text: 'x', source: 'file' });
  check('重名导入返回 409', r.status === 409);
}

// 7. chat SSE 透传（若配了 LLM）
if (cfg.data?.ready) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: '你是知识库问答助手，只能依据片段作答并以[n]标注引用编号。' },
        { role: 'user', content: '「参考片段」如下：\n\n【片段 1】来源：t.md\n撮合延迟端到端 50 到 200 微秒。\n\n---\n\n问题：撮合延迟典型范围是多少？请标注引用编号。' },
      ],
    }),
  });
  const text = await res.text();
  check('chat SSE 透传', res.ok && text.includes('data: '), `${text.length} bytes`);
  check('SSE 结尾带 [DONE]', /data: \[DONE\]/.test(text));
} else {
  console.log('  (LLM 未配置，跳过 chat 测试)');
}

// 8. 清场
await j('DELETE', '/api/kb/docs');
const after = await j('GET', '/api/kb/docs');
check('清空后为 0 篇', (after.data?.docs || []).length === 0);

console.log(`\n\x1b[1mE2E 结果：${pass} 通过 / ${fail} 失败\x1b[0m\n`);
process.exit(fail ? 1 : 0);
