import { Button } from 'tdesign-react';
import { useEffect, useRef, useState } from 'react';
import { useKbStore } from '../stores/kb.js';
import { useConfigStore } from '../stores/config.js';
import { Dropzone } from './Dropzone.js';
import { ConfluenceImport } from './ConfluenceImport.js';
import { DocList } from './DocList.js';
import { ConvList } from './ConvList.js';

export function Sidebar() {
  const config = useConfigStore((s) => s.config);
  const loadSeed = useKbStore((s) => s.loadSeed);
  const clearAll = useKbStore((s) => s.clearAll);
  const docs = useKbStore((s) => s.docs);
  const distillJob = useKbStore((s) => s.distillJob);
  const startDistillAll = useKbStore((s) => s.startDistillAll);
  const stopDistillAll = useKbStore((s) => s.stopDistillAll);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // 清空需要管理员令牌。clearEnabled=false（服务端没配 ADMIN_TOKEN）→ 按钮直接隐藏。
  const clearEnabled = !!config?.clearEnabled;
  const [hasAdminToken, setHasAdminToken] = useState(() => !!sessionStorage.getItem('kqa.adminToken'));

  // 清空二次确认
  const [clearArmed, setClearArmed] = useState(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (armTimer.current) clearTimeout(armTimer.current); }, []);

  async function onClearClick() {
    if (!docs.length) return;
    if (!hasAdminToken) {
      const tok = window.prompt('清空知识库需要管理员令牌。请输入 ADMIN_TOKEN：');
      if (!tok) return;
      sessionStorage.setItem('kqa.adminToken', tok.trim());
      setHasAdminToken(true);
      getToast('令牌已记录，请再次点击「清空」确认');
      return;
    }
    if (!clearArmed) {
      setClearArmed(true);
      if (armTimer.current) clearTimeout(armTimer.current);
      armTimer.current = setTimeout(() => setClearArmed(false), 4000);
      return;
    }
    setClearArmed(false);
    if (armTimer.current) clearTimeout(armTimer.current);
    await clearAll();
    setHasAdminToken(!!sessionStorage.getItem('kqa.adminToken'));
  }

  const channelText = config?.ready
    ? `服务端模型 · ${config.model}`
    : '未配置模型';

  const jobRunning = !!distillJob?.running;
  const jobDone = distillJob && !distillJob.running && distillJob.finishedAt;
  const jobTotal = (distillJob?.done || 0) + (distillJob?.skipped || 0) + (distillJob?.failed || 0);
  const jobPct = jobTotal > 0 ? Math.round(((distillJob!.done + distillJob!.skipped) / jobTotal) * 100) : 0;

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="brand">
          <div className="brand-mark">知</div>
          <div className="brand-text">
            <h1>知识问答 Agent</h1>
            <p>每条回答都标出处</p>
          </div>
        </div>
      </div>

      <div className="side-section">
        <Dropzone />
        <ConfluenceImport />

        <div className="kb-actions">
          <Button variant="outline" size="small" onClick={() => loadSeed()}>载入示例</Button>
          <Button variant="outline" size="small" onClick={() => window.dispatchEvent(new CustomEvent('open-summary'))}>汇总</Button>
          {clearEnabled ? (
            <button
              className={`btn btn-sm ${clearArmed ? 'btn-danger-armed' : 'btn-ghost danger'}`}
              title={clearArmed ? '再点一次确认清空' : '清空全部文档（不可恢复，需管理员令牌）'}
              onClick={onClearClick}
            >
              {clearArmed ? `确认清空 ${docs.length} 篇` : '清空'}
            </button>
          ) : (
            <Button variant="outline" size="small" disabled title="清空功能未启用：服务端需设置 ADMIN_TOKEN">清空（禁用）</Button>
          )}
        </div>

        <div className="distill-all">
          {jobRunning ? (
            <>
              <div className="distill-progress">
                <div className="distill-bar" style={{ width: `${jobPct}%` }}></div>
              </div>
              <div className="distill-progress-text">
                批量蒸馏 {distillJob!.done + distillJob!.skipped}/{jobTotal}
                {distillJob!.failed ? `（${distillJob!.failed} 失败）` : ''}
                {distillJob!.current ? ` · ${distillJob!.current}` : ''}
              </div>
              <Button variant="outline" size="small" onClick={() => void stopDistillAll()}>停止</Button>
            </>
          ) : (
            <>
              {jobDone && (
                <div className="distill-progress-text done">
                  上次批量：成功 {distillJob!.done} · 跳过 {distillJob!.skipped} · 失败 {distillJob!.failed}
                  {distillJob!.aborted ? '（已中断）' : ''}
                </div>
              )}
              <Button
                variant="outline"
                size="small"
                block
                title="后台逐篇调用 LLM 蒸馏所有未处理切片，已有蒸馏的自动跳过。需要管理员令牌。"
                onClick={() => void startDistillAll()}
              >💡 批量蒸馏全库</Button>
            </>
          )}
        </div>

        <DocList />
        <ConvList />
      </div>

      <div className="side-foot">
        <Button block theme="default" onClick={() => setSettingsOpen(true)}>
          <span className={`dot ${config?.ready ? 'on' : 'off'}`}></span>
          <span>{channelText}</span>
        </Button>
      </div>
      {settingsOpen && <SettingsModalHost onClose={() => setSettingsOpen(false)} />}
    </aside>
  );
}

function getToast(text: string, type?: '' | 'ok' | 'err') {
  useKbStore.getState().toast(text, type);
}

function SettingsModalHost({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const evt = new CustomEvent('open-settings');
    window.dispatchEvent(evt);
    onClose();
  }, [onClose]);
  return null;
}
