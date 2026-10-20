import { useEffect, useState } from 'react';
import { useConfigStore } from '../stores/config.js';
import { useKbStore } from '../stores/kb.js';

export function SettingsModal() {
  const [open, setOpen] = useState(false);
  const config = useConfigStore((s) => s.config);
  const sensitivity = useConfigStore((s) => s.sensitivity);
  const topK = useConfigStore((s) => s.topK);
  const temperature = useConfigStore((s) => s.temperature);
  const setSensitivity = useConfigStore((s) => s.setSensitivity);
  const setTopK = useConfigStore((s) => s.setTopK);
  const setTemperature = useConfigStore((s) => s.setTemperature);

  useEffect(() => {
    function onOpen() { setOpen(true); }
    window.addEventListener('open-settings', onOpen);
    return () => window.removeEventListener('open-settings', onOpen);
  }, []);

  if (!open) return null;

  const sensText = (v: number) =>
    v <= 20 ? '很严' : v <= 40 ? '偏严' : v <= 60 ? '中' : v <= 80 ? '偏松' : '很松';

  return (
    <div className="modal-mask" onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className="modal">
        <div className="modal-head">
          <h3>检索设置</h3>
          <button className="icon-btn" onClick={() => setOpen(false)}>✕</button>
        </div>
        <div className="modal-body">
          <div className="notice notice-info">
            模型接入已由服务端统一配置：{config?.ready
              ? `${config.model} @ ${config.baseUrlHost}（密钥在服务端，不下发浏览器）`
              : '未配置（仅检索模式可用）'}
          </div>
          <label className="field">
            <span className="field-label">检索灵敏度<span className="field-tip">调高更容易判定为「有依据」，调低更严格</span></span>
            <div className="slider-row">
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={sensitivity}
                onChange={(e) => setSensitivity(Number(e.target.value))}
              />
              <span className="slider-val">{sensText(sensitivity)}</span>
            </div>
          </label>
          <div className="field-row">
            <label className="field">
              <span className="field-label">取用片段数</span>
              <input
                type="number"
                min={1}
                max={12}
                value={topK}
                onChange={(e) => setTopK(Math.max(1, Math.min(12, Number(e.target.value) || 5)))}
              />
            </label>
            <label className="field">
              <span className="field-label">温度</span>
              <input
                type="number"
                step={0.1}
                min={0}
                max={2}
                value={temperature}
                onChange={(e) => setTemperature(Number(e.target.value) || 0.2)}
              />
            </label>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={() => setOpen(false)}>关闭</button>
        </div>
      </div>
    </div>
  );
}

void useKbStore;
