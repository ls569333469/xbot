import React from 'react';
import { SignalStatus, PositionStatus } from '../../lib/types';

interface StatusBadgeProps {
  status: SignalStatus | PositionStatus | 'active' | 'paused' | 'locked' | 'armed';
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status }) => {
  let bgColor = 'rgba(255, 255, 255, 0.1)';
  let color = 'var(--color-text-primary)';
  let glow = false;

  switch (status) {
    case 'active':
    case 'armed':
    case 'open':
    case 'executed':
    case 'approved':
      bgColor = 'rgba(0, 214, 143, 0.15)';
      color = 'var(--color-success)';
      glow = true;
      break;
    case 'pending':
      bgColor = 'rgba(255, 165, 2, 0.15)';
      color = 'var(--color-warning)';
      break;
    case 'failed':
    case 'sl_hit':
    case 'rejected':
      bgColor = 'rgba(255, 71, 87, 0.15)';
      color = 'var(--color-danger)';
      break;
    case 'tp_hit':
      bgColor = 'rgba(52, 152, 219, 0.15)';
      color = 'var(--color-info)';
      break;
    case 'paused':
    case 'locked':
    case 'expired':
    case 'recorded':
    case 'manual_close':
      bgColor = 'rgba(85, 85, 112, 0.3)';
      color = 'var(--color-text-secondary)';
      break;
  }

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '4px 10px',
        borderRadius: '9999px',
        fontSize: '0.75rem',
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        backgroundColor: bgColor,
        color: color,
        border: `1px solid ${color}`,
        boxShadow: glow ? `0 0 8px ${color}40` : 'none',
      }}
    >
      {status.replace('_', ' ')}
    </span>
  );
};
