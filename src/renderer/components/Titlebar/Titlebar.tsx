import React from 'react';
import '../../styles/titlebar.css';

interface TitlebarProps {
  title?: string;
}

export default function Titlebar({ title }: TitlebarProps) {
  return (
    <div className="titlebar">
      <span className="titlebar__title">{title ?? ''}</span>
    </div>
  );
}
