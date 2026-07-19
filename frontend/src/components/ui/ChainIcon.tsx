import React from 'react';
import { ChainId } from '../../lib/types';

interface ChainIconProps {
  chain: ChainId;
  size?: 'sm' | 'md' | 'lg';
}

const colors: Record<ChainId, string> = {
  sol: 'var(--color-chain-sol)',
  bsc: 'var(--color-chain-bsc)',
  base: 'var(--color-chain-base)',
  eth: 'var(--color-chain-eth)',
  robinhood: 'var(--color-chain-robin)',
};

const shortNames: Record<ChainId, string> = {
  sol: 'SOL',
  bsc: 'BSC',
  base: 'BASE',
  eth: 'ETH',
  robinhood: 'ROB',
};

const sizes = {
  sm: { width: 20, height: 20, fontSize: '0.6rem' },
  md: { width: 28, height: 28, fontSize: '0.75rem' },
  lg: { width: 40, height: 40, fontSize: '1rem' },
};

export const ChainIcon: React.FC<ChainIconProps> = ({ chain, size = 'md' }) => {
  const style = sizes[size];
  
  return (
    <div 
      title={chain.toUpperCase()}
      style={{
        ...style,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '50%',
        backgroundColor: colors[chain] || '#555',
        color: 'white',
        fontWeight: 'bold',
        textTransform: 'uppercase',
        boxShadow: '0 2px 4px rgba(0,0,0,0.2)'
      }}
    >
      {shortNames[chain] || chain.slice(0, 3)}
    </div>
  );
};
