import { useEffect, useState } from 'react';
import { PinIcon, DeleteIcon, BrowseIcon } from 'tdesign-icons-react';
import { useConvStore } from '../stores/convs.js';
import { useChatStore } from '../stores/chat.js';

/** 对话历史列表（服务端持久化）。放在侧栏文档列表上方。 */
export function ConvList() {
  const convs = useConvStore((s) => s.convs);
  const currentId = useConvStore((s) => s.currentId);
  const refresh = useConvStore((s) => s.refresh);
  const removeConv = useConvStore((s) => s.removeConv);
  const togglePin = useConvStore((s) => s.togglePin);
  const loadFromServer = useChatStore((s) => s.loadFromServer);
  const streaming = useChatStore((s) => s.streaming);
  const [filter, setFilter] = useState('');

  useEffect(() => { void refresh(); }, [refresh]);

  const shown = convs.filter((c) =>
    !filter.trim() || c.title.toLowerCase().includes(filter.trim().toLowerCase()));

  async function open(id: string) {
    if (streaming) return;
    if (id === currentId) return;
    const ok = await loadFromServer(id);
    if (!ok) void refresh();
  }

  if (!convs.length && !filter) return null; // 没历史时不占侧栏空间

  return (
    <div className="conv-list-wrap">
      <div className="side-title">
        <span>对话历史</span>
        <span className="pill">{convs.length}</span>
      </div>
      {convs.length > 3 && (
        <input
          className="doc-filter"
          placeholder="搜索对话标题…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      )}
      <ul className="conv-list">
        {shown.map((c) => (
          <li
            key={c.id}
            className={`conv-item${c.id === currentId ? ' active' : ''}`}
            onClick={() => void open(c.id)}
            title={`${c.title} · ${c.messageCount} 条消息`}
          >
            <div className="conv-meta">
              <div className="conv-title">
                {c.pinned ? '📌 ' : ''}{c.title}
              </div>
              <div className="conv-sub">
                {new Date(c.updatedAt).toLocaleString('zh-CN', {
                  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
                })} · {c.messageCount} 条
              </div>
            </div>
            <div className="conv-actions" onClick={(e) => e.stopPropagation()}>
              <button
                className="icon-btn"
                title={c.pinned ? '取消置顶' : '置顶'}
                onClick={() => void togglePin(c.id)}
              ><PinIcon /></button>
              <button
                className="icon-btn"
                title="删除对话"
                onClick={() => {
                  if (!confirm(`删除对话「${c.title}」？`)) return;
                  void removeConv(c.id);
                }}
              ><DeleteIcon /></button>
            </div>
          </li>
        ))}
        {!shown.length && filter && <li className="doc-empty">无匹配对话</li>}
      </ul>
    </div>
  );
}

void BrowseIcon;
