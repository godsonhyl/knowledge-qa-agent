import { useKbStore } from '../stores/kb.js';

export function Toast() {
  const toasts = useKbStore((s) => s.toasts);
  const dismiss = useKbStore((s) => s.dismissToast);

  return (
    <div className="toast-wrap">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast ${t.type}`}
          style={{ whiteSpace: 'pre-wrap' }}
          onClick={() => dismiss(t.id)}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
