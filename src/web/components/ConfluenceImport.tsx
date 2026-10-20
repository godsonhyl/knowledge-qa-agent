import { useState } from 'react';
import { useKbStore } from '../stores/kb.js';
import { useConfigStore } from '../stores/config.js';

export function ConfluenceImport() {
  const [url, setUrl] = useState('');
  const importConfluence = useKbStore((s) => s.importConfluence);
  const config = useConfigStore((s) => s.config);
  const loading = useKbStore((s) => s.loading);

  const onImport = (recursive: boolean) => {
    if (!url.trim()) return useKbStore.getState().toast('请先粘贴 Confluence 页面 URL');
    if (!config?.confluence) return useKbStore.getState().toast('服务端未配置 Confluence 接入', 'err');
    void importConfluence(url.trim(), recursive);
  };

  return (
    <div className="paste-box conf-box-wrap">
      <input
        type="text"
        value={url}
        placeholder="Confluence 页面链接，如 https://wiki/pages/viewpage.action?pageId=123"
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) onImport(false);
        }}
      />
      <div className="conf-btns">
        <button className="btn btn-sm btn-ghost" disabled={loading} onClick={() => onImport(false)}>导入页面</button>
        <button className="btn btn-sm btn-ghost" disabled={loading} onClick={() => onImport(true)}>导入子树</button>
      </div>
      <div className="dir-hint">
        「导入页面」只抓这一页；「导入子树」抓该页及全部子孙（上限 200 页）。
        {config?.confluence ? '' : '（服务端未配置，暂不可用）'}
      </div>
    </div>
  );
}
