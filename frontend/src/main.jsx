import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { AuthProvider } from './contexts/AuthContext.jsx'

async function ensurePersistentStorage() {
  try {
    if (!('storage' in navigator) || !navigator.storage) return;

    if (typeof navigator.storage.persisted === 'function') {
      const alreadyPersisted = await navigator.storage.persisted();
      if (alreadyPersisted) return;
    }

    if (typeof navigator.storage.persist === 'function') {
      await navigator.storage.persist();
    }
  } catch (err) {
    console.debug('persistent storage request skipped:', err);
  }
}

ensurePersistentStorage();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </StrictMode>,
)
