import React from 'react';
import { SignalStatus, PositionStatus } from '../../lib/types';
import { statusLabel } from '../../lib/display-labels';

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
    case 'open_protected':
    case 'executed':
    case 'approved':
      bgColor = 'rgba(0, 214, 143, 0.15)';
      color = 'var(--color-success)';
      glow = true;
      break;
    case 'pending':
    case 'execution_reserved':
    case 'closing':
      bgColor = 'rgba(255, 165, 2, 0.15)';
      color = 'var(--color-warning)';
      break;
    case 'failed':
    case 'close_uncertain':
    case 'protection_failed':
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
    case 'closed':
    case 'partially_closed':
    case 'open_unprotected':
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
        letterSpacing: 0,
        backgroundColor: bgColor,
        color: color,
        border: `1px solid ${color}`,
        boxShadow: glow ? `0 0 8px ${color}40` : 'none',
      }}
    >
      {statusLabel(status)}
    </span>
  );
};
