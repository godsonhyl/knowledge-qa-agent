import React, { useEffect } from 'react';
import { useConfigStore } from './stores/config.js';
import { useKbStore } from './stores/kb.js';
import { useChatStore } from './stores/chat.js';
import { Sidebar } from './components/Sidebar.js';
import { ChatView } from './components/ChatView.js';
import { ViewerModal } from './components/ViewerModal.js';
import { SummaryModal } from './components/SummaryModal.js';
import { SettingsModal } from './components/SettingsModal.js';
import { FeedbackModal } from './components/FeedbackModal.js';
import { Toast } from './components/Toast.js';

export function App() {
  const loadConfig = useConfigStore((s) => s.loadConfig);
  const refresh = useKbStore((s) => s.refresh);
  const restore = useChatStore((s) => s.restore);

  useEffect(() => {
    void loadConfig();
    void refresh();
    restore();
  }, [loadConfig, refresh, restore]);

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
