import React, { useEffect } from 'react';
import { useConfigStore } from './stores/config.js';
import { useKbStore } from './stores/kb.js';
import { useChatStore } from './stores/chat.js';
import { useAuthStore } from './stores/auth.js';
import { Sidebar } from './components/Sidebar.js';
import { ChatView } from './components/ChatView.js';
import { ViewerModal } from './components/ViewerModal.js';
import { SummaryModal } from './components/SummaryModal.js';
import { SettingsModal } from './components/SettingsModal.js';
import { FeedbackModal } from './components/FeedbackModal.js';
import { Toast } from './components/Toast.js';
import { LoginPage } from './components/LoginPage.js';

export function App() {
  const config = useConfigStore((s) => s.config);
  const loadConfig = useConfigStore((s) => s.loadConfig);
  const refresh = useKbStore((s) => s.refresh);
  const restore = useChatStore((s) => s.restore);
  const isAuthed = useAuthStore((s) => s.isAuthed);

  useEffect(() => {
    // 回调页写完 localStorage 跳回 '/'，这里同步一次会话状态
    useAuthStore.getState().syncFromStorage();
    void loadConfig();
  }, [loadConfig]);

  // boot 加载要在 config 就绪后、且「已登录或不需要登录」时执行。
  // ssoRequired=false（默认免鉴权）→ 直接加载；ssoRequired=true 且未登录 → 只渲染登录页，不触发受保护 API。
  const ssoRequired = !!config?.sso?.required;
  const bootReady = !!config && (!ssoRequired || isAuthed);
  useEffect(() => {
    if (!bootReady) return;
    void refresh();
    restore();
    // 启动时探一次批量蒸馏任务——服务端可能正跑着（重启不丢任务状态），
    // 有的话接上轮询显示进度条，避免用户看不到进行中的蒸馏。
    void useKbStore.getState().pollDistillJob();
  }, [bootReady, refresh, restore]);

  if (config && ssoRequired && !isAuthed) {
    return <LoginPage sso={config.sso} required />;
  }

  // 未开始加载 config 时保持首屏骨架（避免首页闪一下登录页再弹回）
  if (!config) {
    return <div className="app app-boot" />;
  }

  return (
    <div className="app">
      <Sidebar />
      <ChatView />
      <ViewerModal />
      <SummaryModal />
      <SettingsModal />
      <FeedbackModal />
      <Toast />
    </div>
  );
}
