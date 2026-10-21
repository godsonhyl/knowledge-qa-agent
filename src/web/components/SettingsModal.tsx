import { Slider, Switch, InputNumber, Button } from 'tdesign-react';
import { useEffect, useState } from 'react';
import { useConfigStore } from '../stores/config.js';
import { useKbStore } from '../stores/kb.js';

export function SettingsModal() {
  const [open, setOpen] = useState(false);
  const config = useConfigStore((s) => s.config);
  const sensitivity = useConfigStore((s) => s.sensitivity);
  const topK = useConfigStore((s) => s.topK);
  const temperature = useConfigStore((s) => s.temperature);
  const fallbackOnNoEvidence = useConfigStore((s) => s.fallbackOnNoEvidence);
  const setSensitivity = useConfigStore((s) => s.setSensitivity);
  const setTopK = useConfigStore((s) => s.setTopK);
  const setTemperature = useConfigStore((s) => s.setTemperature);
  const setFallbackOnNoEvidence = useConfigStore((s) => s.setFallbackOnNoEvidence);

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
          <div className="notice notice-info settings-model-note">
            模型接入已由服务端统一配置：{config?.ready
              ? `${config.model} @ ${config.baseUrlHost}（密钥在服务端，不下发浏览器）`
              : '未配置（仅检索模式可用）'}
          </div>
          <label className="field">
            <span className="field-label">检索灵敏度<span className="field-tip">调高更容易判定为「有依据」，调低更严格</span></span>
            <div className="slider-row">
              <Slider
                min={0}
                max={100}
                step={5}
                value={sensitivity}
                onChange={(v: any) => setSensitivity(Number(v))}
              />
              <span className="slider-val">{sensText(sensitivity)}</span>
            </div>
          </label>
          <label className="field field-switch">
            <span className="field-label">无据时大模型兜底<span className="field-tip">检索无依据时让大模型用自身知识回答并醒目标注「非知识库依据」；关闭则纯拒答</span></span>
            <Switch
              value={fallbackOnNoEvidence}
              onChange={(v: any) => setFallbackOnNoEvidence(!!v)}
            />
          </label>
          <div className="field-row">
            <label className="field">
              <span className="field-label">取用片段数</span>
              <InputNumber
                min={1}
                max={12}
                value={topK}
                onChange={(v: any) => setTopK(Math.max(1, Math.min(12, Number(v) || 8)))}
              />
            </label>
            <label className="field">
              <span className="field-label">温度</span>
              <InputNumber
                step={0.1}
                min={0}
                max={2}
                value={temperature}
                onChange={(v: any) => setTemperature(Number(v) || 0.2)}
              />
            </label>
          </div>
        </div>
        <div className="modal-foot">
          <Button variant="outline" onClick={() => setOpen(false)}>关闭</Button>
        </div>
      </div>
    </div>
  );
}

void useKbStore;
