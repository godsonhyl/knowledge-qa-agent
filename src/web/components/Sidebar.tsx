import React, { useState } from 'react';
import { useKbStore } from '../stores/kb.js';
import { useConfigStore } from '../stores/config.js';
import { Dropzone } from './Dropzone.js';
import { ConfluenceImport } from './ConfluenceImport.js';
import { DocList } from './DocList.js';
import { SOURCE_LABELS } from '@shared/types.js';

export function Sidebar() {
  const config = useConfigStore((s) => s.config);
  const loadSeed = useKbStore((s) => s.loadSeed);
  const clearAll = useKbStore((s) => s.clearAll);
  const docs = useKbStore((s) => s.docs);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const channelText = config?.ready
    ? `服务端模型 · ${config.model}`
    : '未配置模型';

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
        <DocList />

        <div className="kb-actions">
          <button className="btn btn-sm btn-ghost" onClick={() => loadSeed()}>载入示例知识库</button>
          <button className="btn btn-sm btn-ghost" onClick={() => window.dispatchEvent(new CustomEvent('open-summary'))}>知识库汇总</button>
          <button
            className="btn btn-sm btn-ghost danger"
            onClick={() => {
              if (!docs.length) return;
              if (!confirm(`确定清空全部 ${docs.length} 篇文档？此操作不可恢复。`)) return;
              void clearAll();
            }}
          >清空</button>
        </div>
      </div>

      <div className="side-foot">
        <button className="btn btn-block btn-primary" onClick={() => setSettingsOpen(true)}>
          <span className={`dot ${config?.ready ? 'on' : 'off'}`}></span>
          <span>{channelText}</span>
        </button>
      </div>
      {settingsOpen && <SettingsModalHost onClose={() => setSettingsOpen(false)} />}
    </aside>
  );
}

function SettingsModalHost({ onClose }: { onClose: () => void }) {
  // 由 App 顶层渲染全局 modal；这里只触发
  React.useEffect(() => {
    const evt = new CustomEvent('open-settings');
    window.dispatchEvent(evt);
    onClose();
  }, [onClose]);
  return null;
}

void SOURCE_LABELS;
