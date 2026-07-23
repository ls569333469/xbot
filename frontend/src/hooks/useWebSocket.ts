import { useContext } from 'react';
import { WebSocketContext } from './WebSocketContext';

export { WebSocketProvider } from './WebSocketProvider';

export const useWebSocket = () => useContext(WebSocketContext);
