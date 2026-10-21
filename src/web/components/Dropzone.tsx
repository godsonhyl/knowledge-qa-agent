import { Button, Input, Textarea } from 'tdesign-react';
import { UploadIcon, FolderOpenIcon } from 'tdesign-icons-react';
import { useRef } from 'react';
import { useKbStore } from '../stores/kb.js';

export function Dropzone() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pasteRef = useRef<HTMLTextAreaElement>(null);
  const importFiles = useKbStore((s) => s.importFiles);
  const addDoc = useKbStore((s) => s.addDoc);

  async function handleFiles(list: FileList | null) {
    if (!list) return;
    const files: { name: string; text: string }[] = [];
    const pdfs: File[] = [];
    for (const f of Array.from(list)) {
      if (/\.pdf$/i.test(f.name)) { pdfs.push(f); continue; }
      if (f.size > 5 * 1024 * 1024) continue;
      let text = await f.text();
      if (/\.html?$/i.test(f.name)) {
        text = text
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/\n{3,}/g, '\n\n');
      }
      files.push({ name: f.name, text });
    }
    if (pdfs.length) await useKbStore.getState().uploadPdfs(pdfs);
    if (files.length) await importFiles(files);
  }

  function addPaste() {
    const text = (pasteRef.current?.value || '').trim();
    if (!text) return;
    const name = `粘贴片段 ${new Date().toLocaleString('zh-CN', { hour12: false }).replace(/[/:]/g, '-')}.txt`;
    void addDoc(name, text, 'paste').then(() => {
      if (pasteRef.current) pasteRef.current.value = '';
    });
  }

  return (
    <div className="dropzone-box">
      <div
        className="dropzone"
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); }}
        onDrop={(e) => { e.preventDefault(); void handleFiles(e.dataTransfer.files); }}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".txt,.md,.markdown,.json,.csv,.log,.py,.js,.ts,.java,.cpp,.h,.go,.yaml,.yml,.html,.css,.pdf,application/pdf"
          style={{ display: 'none' }}
          onChange={(e) => { void handleFiles(e.target.files); e.target.value = ''; }}
        />
        <div className="dz-icon"><UploadIcon /></div>
        <div className="dz-main">拖入文件 或 点击选择</div>
        <div className="dz-sub">支持 txt / md / 代码 / csv / pdf · 文本 ≤ 5MB · PDF ≤ 500MB</div>
      </div>
      <div className="paste-box">
        <Textarea
          ref={pasteRef as any}
          autosize={{ minRows: 2, maxRows: 5 }}
          placeholder="或直接粘贴一段文本作为知识库内容…"
        />
        <Button variant="outline" size="small" onClick={addPaste}>添加</Button>
      </div>
      <Button
        variant="outline"
        size="small"
        block
        icon={<FolderOpenIcon />}
        id="btnPickLocalDir"
        onClick={() => {
          void (async () => {
            if (typeof (window as any).showDirectoryPicker !== 'function') {
              useKbStore.getState().toast('当前浏览器不支持选择本机目录，请用 Chrome/Edge 86+（需 HTTPS 或 localhost）', 'err');
              return;
            }
            try {
              const handle = await (window as any).showDirectoryPicker({ mode: 'read' });
              const collected: { name: string; text: string }[] = [];
              const pdfs: File[] = [];
              async function walk(dir: any, prefix: string) {
                for await (const [n, child] of dir.entries()) {
                  if (n.startsWith('.')) continue;
                  const rel = prefix ? `${prefix}/${n}` : n;
                  if (child.kind === 'directory') { await walk(child, rel); }
                  else if (child.kind === 'file') {
                    const ext = n.slice(n.lastIndexOf('.')).toLowerCase();
                    if (!['.txt', '.md', '.csv', '.pdf'].includes(ext)) continue;
                    const f = await child.getFile();
                    if (ext === '.pdf') {
                      if (f.size > 500 * 1024 * 1024) continue;
                      pdfs.push(f);
                    } else {
                      if (f.size > 5 * 1024 * 1024) continue;
                      collected.push({ name: rel, text: await f.text() });
                    }
                    if (collected.length + pdfs.length >= 500) return;
                  }
                }
              }
              await walk(handle, '');
              if (pdfs.length) await useKbStore.getState().uploadPdfs(pdfs);
              await useKbStore.getState().importDir(collected);
            } catch (e: any) {
              if (e?.name !== 'AbortError') useKbStore.getState().toast(`扫描失败：${e?.message || e}`, 'err');
            }
          })();
        }}
      >选择本机目录</Button>
    </div>
  );
}
