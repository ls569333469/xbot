import React, { useState, useCallback, ReactNode } from 'react';
import { ToastContext, ToastType } from './ToastContext';

interface ToastMessage {
  id: string;
  type: ToastType;
  message: string;
}

export const ToastProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const toast = useCallback((message: string, type: ToastType = 'info') => {
    const id = Math.random().toString(36).substr(2, 9);
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div 
        style={{
          position: 'fixed',
          bottom: '24px',
          right: '24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          zIndex: 9999,
        }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className="card animate-slide-in"
            style={{
              padding: '12px 20px',
              borderLeft: `4px solid ${
                t.type === 'success' ? 'var(--color-success)' :
                t.type === 'error' ? 'var(--color-danger)' :
                t.type === 'warning' ? 'var(--color-warning)' :
                'var(--color-info)'
              }`,
              minWidth: '250px'
            }}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};
