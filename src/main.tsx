import { StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import App from './App';
import './shared/styles/index.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element #root not found');

createRoot(rootElement).render(
  <StrictMode>
    <BrowserRouter>
      <Suspense
        fallback={
          <div className="mono p-10 text-[12px] text-[var(--text-muted)]">Loading…</div>
        }
      >
        <App />
      </Suspense>
    </BrowserRouter>
  </StrictMode>,
);
