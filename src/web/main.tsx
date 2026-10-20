import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './app.css';

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
