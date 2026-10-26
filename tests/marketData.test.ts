/* ============================================================
   tests/marketData.test.ts —— 行情模块判定函数 + 可信度排序单测
   v2.8.1 起行情/基差直查通道从 search 路由移除（一切先走知识库），
   marketData 模块保留（判定函数 + push2 取数能力），测试验证判定逻辑本身。
   §MD-1 isMarketQuery：行情类问题识别（排除定义类问题）
   §MD-2 tryMarketDirect：取数（外网依赖，允许 null）
   §CR-1 credibilityScore：白名单优先、黑名单靠后、原序平局
   ============================================================ */
import { describe, it, expect } from 'vitest';

const { isMarketQuery, tryMarketDirect } = await import('../src/server/marketData.js');

describe('§MD-1 isMarketQuery', () => {
  it('行情类问题识别', () => {
    expect(isMarketQuery('上证指数收盘价')).toBe(true);
    expect(isMarketQuery('上周五A股大盘收盘行情')).toBe(true);
    expect(isMarketQuery('中证1000 最新行情')).toBe(true);
    expect(isMarketQuery('创业板指现在多少点')).toBe(true);
  });
  it('定义/原理类问题不算行情查询（走知识库）', () => {
    expect(isMarketQuery('什么是收盘价')).toBe(false);
    expect(isMarketQuery('基差公式怎么算的')).toBe(false);
    expect(isMarketQuery('自成交检查怎么做')).toBe(false);
    expect(isMarketQuery('撮合延迟典型范围')).toBe(false);
  });
  it('期货/基差/期现类问题不放直查（现货数据答不全，避免答非所问）', () => {
    expect(isMarketQuery('中证1000 现货与期货 实时基差')).toBe(false);
    expect(isMarketQuery('中证1000股指期货 基差')).toBe(false);
    expect(isMarketQuery('IM 主力合约 升贴水')).toBe(false);
    expect(isMarketQuery('沪深300 期货与现货 基差率')).toBe(false);
  });
});

describe('§MD-2 extractIndexCode（经 tryMarketDirect 行为验证）', () => {
  it('"大盘"默认映射上证指数（接口可用时）', async () => {
    // 依赖外网 push2 接口——本环境可能无出口，允许 null
    const r = await tryMarketDirect('A股大盘最新行情');
    expect(r === null || r.name === '上证指数').toBe(true);
  });
  it('非行情问题返回 null', async () => {
    expect(await tryMarketDirect('自成交检查怎么做')).toBeNull();
  });
});

describe('§CR-1 可信度排序', () => {
  it('白名单域名评分高于黑名单', async () => {
    const { rankByCredibility } = await import('../src/server/routes/webSearch.js');
    const hits = [
      { title: 'CSDN 博客', url: 'https://blog.csdn.net/x', content: 'x', scraped: false },
      { title: '上交所官网', url: 'https://www.sse.com.cn/x', content: 'x', scraped: false },
      { title: '雪球 UGC', url: 'https://xueqiu.com/x', content: 'x', scraped: false },
      { title: '东财', url: 'https://quote.eastmoney.com/x', content: 'x', scraped: false },
    ];
    rankByCredibility(hits as any);
    // 上交所与东财应排前（具体顺序取决于域名+原序平局），CSDN/雪球沉底
    const domains = hits.map((h) => new URL(h.url).hostname);
    expect(domains.indexOf('www.sse.com.cn')).toBeLessThan(domains.indexOf('blog.csdn.net'));
    expect(domains.indexOf('quote.eastmoney.com')).toBeLessThan(domains.indexOf('xueqiu.com'));
  });
  it('引擎共识数加分（同域名权重下仍生效）', async () => {
    const { rankByCredibility } = await import('../src/server/routes/webSearch.js');
    const hits = [
      { title: 'A', url: 'https://news.example.org/x', content: 'x', scraped: false, engines: ['b', 'c', 'd'] },
      { title: 'B', url: 'https://blog.example.org/y', content: 'y', scraped: false, engines: ['b'] },
    ];
    rankByCredibility(hits as any);
    expect(hits[0]!.title).toBe('A'); // 3 引擎共识 > 1 引擎
  });
});
