import React, { useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { getAuthToken } from '../lib/api';
import { WebSocketContext, WebSocketStatus, WsEvent } from './WebSocketContext';

function encodeWebSocketToken(token: string) {
  const bytes = new TextEncoder().encode(token);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return window.btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export const WebSocketProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [status, setStatus] = useState<WebSocketStatus>('disconnected');
  const [lastEvent, setLastEvent] = useState<WsEvent | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const attemptRef = useRef(0);
  const seenEventIdsRef = useRef(new Set<string>());

  const connect = useCallback(() => {
    try {
      const authToken = getAuthToken();
      if (!authToken) {
        setStatus('disconnected');
        return;
      }

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const configuredPath = import.meta.env.VITE_WS_PATH;
      const mountedPath = `${import.meta.env.BASE_URL}ws`.replace(/\/+/g, '/');
      const wsPath = configuredPath || mountedPath;
      const normalizedPath = wsPath.startsWith('/') ? wsPath : `/${wsPath}`;
      const wsUrl = `${protocol}//${window.location.host}${normalizedPath}`;
      setStatus('connecting');
      const ws = new WebSocket(wsUrl, ['xbot-auth', encodeWebSocketToken(authToken)]);

      ws.onopen = () => {
        setStatus('connected');
        attemptRef.current = 0;
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as WsEvent;
          if (data.event_id) {
            if (seenEventIdsRef.current.has(data.event_id)) return;
            seenEventIdsRef.current.add(data.event_id);
            if (seenEventIdsRef.current.size > 500) {
              const oldest = seenEventIdsRef.current.values().next().value;
              if (oldest) seenEventIdsRef.current.delete(oldest);
            }
          }
          setLastEvent({
            type: data.type,
            event_id: data.event_id,
            contract_version: data.contract_version,
            payload: data.payload || data
          });
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

  const send = useCallback((type: string, payload: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type, payload }));
    }
  }, []);

  const value = { status, lastEvent, isConnected: status === 'connected', send };

  return React.createElement(WebSocketContext.Provider, { value }, children);
};
