import React, { createContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';

type WebSocketStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

interface WsEvent {
  type: string;
  payload: any;
}

interface WebSocketContextType {
  status: WebSocketStatus;
  lastEvent: WsEvent | null;
  isConnected: boolean;
  send: (type: string, payload: any) => void;
}

export const WebSocketContext = createContext<WebSocketContextType>({
  status: 'disconnected',
  lastEvent: null,
  isConnected: false,
  send: () => {},
});

export const WebSocketProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [status, setStatus] = useState<WebSocketStatus>('disconnected');
  const [lastEvent, setLastEvent] = useState<WsEvent | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const attemptRef = useRef(0);

  const connect = useCallback(() => {
    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws`;
      setStatus('connecting');
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        setStatus('connected');
        attemptRef.current = 0;
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          setLastEvent({ type: data.type, payload: data.payload || data });
        } catch (e) {
          console.error('WebSocket message parse error:', e);
        }
      };

      ws.onclose = () => {
        setStatus('disconnected');
        const timeout = Math.min(1000 * Math.pow(2, attemptRef.current), 30000);
        attemptRef.current += 1;
        reconnectTimeoutRef.current = window.setTimeout(connect, timeout);
      };

      ws.onerror = () => {
        setStatus('error');
      };

      wsRef.current = ws;
    } catch (e) {
      console.error('WebSocket connection error:', e);
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (wsRef.current) wsRef.current.close();
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
    };
  }, [connect]);

  const send = useCallback((type: string, payload: any) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type, payload }));
    }
  }, []);

  const value = { status, lastEvent, isConnected: status === 'connected', send };

  return React.createElement(WebSocketContext.Provider, { value }, children);
};
