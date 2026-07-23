import { createContext } from 'react';

export type WebSocketStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface WsEvent {
  type: string;
  payload: any;
}

export interface WebSocketContextValue {
  status: WebSocketStatus;
  lastEvent: WsEvent | null;
  isConnected: boolean;
  send: (type: string, payload: any) => void;
}

export const WebSocketContext = createContext<WebSocketContextValue>({
  status: 'disconnected',
  lastEvent: null,
  isConnected: false,
  send: () => {},
});
