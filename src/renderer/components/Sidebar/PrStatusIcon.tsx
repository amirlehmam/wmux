import React from 'react';

interface PrStatusIconProps {
  status: 'open' | 'merged' | 'closed';
  size?: number;
}

export default function PrStatusIcon({ status, size = 12 }: PrStatusIconProps) {
  switch (status) {
    case 'open':
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="#3fb950">
          <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354Z" />
        </svg>
      );
    case 'merged':
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="#a371f7">
          <path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218Z" />
        </svg>
      );
    case 'closed':
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="#f85149">
          <path d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-1.22-5.03a.75.75 0 0 1 1.06 0l1.5 1.5a.75.75 0 0 1-1.06 1.06l-1.5-1.5a.75.75 0 0 1 0-1.06Zm0 3.06a.75.75 0 0 1 0-1.06l1.5-1.5a.75.75 0 1 1 1.06 1.06l-1.5 1.5a.75.75 0 0 1-1.06 0Z" />
        </svg>
      );
  }
}
