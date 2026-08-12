import { createContext } from 'react';

export type WebSocketStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface WsEvent {
  type: string;
  event_id?: string;
  contract_version?: string;
  payload: {
    entity_type?: 'signal' | 'position' | 'order' | 'attempt';
    entity_id?: string;
    change_type?: 'created' | 'updated' | 'settled';
    id?: string;
    status?: string;
    symbol?: string | null;
    pnl?: number;
    pnl_pct?: number;
    exit_price?: number;
    sim_peaks?: Record<string, unknown>;
    topic?: string;
    payload?: { reason?: string };
    [key: string]: unknown;
  };
}

export interface WebSocketContextValue {
  status: WebSocketStatus;
  lastEvent: WsEvent | null;
  isConnected: boolean;
  send: (type: string, payload: unknown) => void;
}

export const WebSocketContext = createContext<WebSocketContextValue>({
  status: 'disconnected',
  lastEvent: null,
  isConnected: false,
  send: () => {},
});
