import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import { ToastProvider } from './components/ui/Toast.tsx'
import { WebSocketProvider } from './hooks/useWebSocket'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ToastProvider>
      <WebSocketProvider>
        <App />
      </WebSocketProvider>
    </ToastProvider>
  </React.StrictMode>,
)
