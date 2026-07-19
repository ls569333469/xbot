import React from 'react';

interface SkeletonProps {
  className?: string;
  width?: string | number;
  height?: string | number;
  circle?: boolean;
}

export const Skeleton: React.FC<SkeletonProps> = ({
  className = '',
  width,
  height,
  circle = false,
}) => {
  const style: React.CSSProperties = {
    width: width !== undefined ? (typeof width === 'number' ? `${width}px` : width) : undefined,
    height: height !== undefined ? (typeof height === 'number' ? `${height}px` : height) : undefined,
    borderRadius: circle ? '50%' : undefined,
  };

  return (
    <div
      className={`skeleton ${className}`}
      style={style}
    />
  );
};

export const CardSkeleton: React.FC = () => {
  return (
    <div className="card flex flex-col gap-sm" style={{ minHeight: '112px' }}>
      <Skeleton className="mb-xs" width="40%" height={12} />
      <Skeleton width="60%" height={28} />
      <div className="flex gap-xs items-center" style={{ marginTop: 'auto' }}>
        <Skeleton width={16} height={16} circle />
        <Skeleton width="30%" height={12} />
      </div>
    </div>
  );
};

interface TableSkeletonProps {
  rows?: number;
  cols?: number;
}

export const TableSkeleton: React.FC<TableSkeletonProps> = ({ rows = 5, cols = 5 }) => {
  return (
    <div className="table-container p-md">
      <div className="flex justify-between items-center mb-md">
        <Skeleton width={120} height={20} />
        <Skeleton width={80} height={32} />
      </div>
      <table className="table">
        <thead>
          <tr>
            {Array.from({ length: cols }).map((_, i) => (
              <th key={i}>
                <Skeleton width="60%" height={12} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }).map((_, r) => (
            <tr key={r}>
              {Array.from({ length: cols }).map((_, c) => (
                <td key={c}>
                  {c === 0 ? (
                    <div className="flex items-center gap-sm">
                      <Skeleton width={24} height={24} circle />
                      <Skeleton width={60} height={14} />
                    </div>
                  ) : (
                    <Skeleton width={c === cols - 1 ? 50 : 80} height={14} />
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export const FormSkeleton: React.FC = () => {
  return (
    <div className="card flex flex-col gap-md">
      <div className="flex items-center justify-between mb-sm">
        <Skeleton width={150} height={20} />
      </div>
      <div className="grid grid-cols-2 gap-md">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-xs">
            <Skeleton width="40%" height={12} className="mb-xs" />
            <Skeleton className="w-full" height={38} />
          </div>
        ))}
      </div>
      <div className="flex justify-end gap-sm" style={{ marginTop: 'var(--space-md)' }}>
        <Skeleton width={80} height={36} />
        <Skeleton width={100} height={36} />
      </div>
    </div>
  );
};
