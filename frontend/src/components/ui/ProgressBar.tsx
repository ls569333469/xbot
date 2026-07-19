import React from 'react';

interface ProgressBarProps {
  value: number;
  max: number;
  showText?: boolean;
}

export const ProgressBar: React.FC<ProgressBarProps> = ({ value, max, showText = true }) => {
  const percentage = Math.min(100, Math.max(0, (value / max) * 100)) || 0;
  
  let gradient = 'linear-gradient(90deg, #00d68f 0%, #00d68f 100%)';
  if (percentage > 90) {
    gradient = 'linear-gradient(90deg, #ff4757 0%, #ff4757 100%)';
  } else if (percentage > 70) {
    gradient = 'linear-gradient(90deg, #ffa502 0%, #ffa502 100%)';
  } else {
    gradient = 'linear-gradient(90deg, #3498db 0%, #00d68f 100%)';
  }

  return (
    <div className="flex flex-col gap-xs w-full">
      {showText && (
        <div className="flex justify-between text-xs text-secondary">
          <span>{value.toLocaleString()}</span>
          <span>{max.toLocaleString()}</span>
        </div>
      )}
      <div 
        style={{ 
          height: '8px', 
          width: '100%', 
          backgroundColor: 'rgba(255,255,255,0.05)', 
          borderRadius: '999px',
          overflow: 'hidden'
        }}
      >
        <div 
          style={{ 
            height: '100%', 
            width: `${percentage}%`, 
            background: gradient,
            transition: 'width 0.3s ease'
          }} 
        />
      </div>
      {showText && <div className="text-xs text-right text-muted">{percentage.toFixed(1)}%</div>}
    </div>
  );
};
