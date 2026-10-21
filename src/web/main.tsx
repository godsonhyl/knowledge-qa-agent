import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import 'tdesign-react/dist/tdesign.css';
import './app.css';

// 主题在首帧前落定，避免暗色用户看到白闪
import { useThemeStore } from './stores/theme.js';
useThemeStore.getState().init();

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
