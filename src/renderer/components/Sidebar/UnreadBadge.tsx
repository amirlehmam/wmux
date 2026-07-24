import React from 'react';

interface UnreadBadgeProps {
  count: number;
  isSelected: boolean;
}

export default function UnreadBadge({ count, isSelected }: UnreadBadgeProps) {
  // Styling moved to CSS (`.unread-badge`, sidebar.css). The inline background
  // this used to set beat those rules, so they were dead code — and the
  // hardcoded white-at-25% selected state was invisible in the light theme.
  // The selected variant is now a class, not a colour literal.
  return (
    <span className={`unread-badge${isSelected ? ' unread-badge--on-selected' : ''}`}>
      {count}
    </span>
  );
}
