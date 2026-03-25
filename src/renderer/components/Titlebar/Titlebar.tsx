import React from 'react';
import '../../styles/titlebar.css';

interface TitlebarProps {
  title?: string;
  onHelpClick?: () => void;
  onDevToolsClick?: () => void;
}

export default function Titlebar({ title, onHelpClick, onDevToolsClick }: TitlebarProps) {
  return (
    <div className="titlebar">
      {/* Left spacer for sidebar alignment */}
      <div className="titlebar__left">
        <button
          className="titlebar__btn"
          onClick={onHelpClick}
          title="Help / Tutorial"
        >
          ?
        </button>
        <button
          className="titlebar__btn"
          onClick={onDevToolsClick}
          title="Toggle Developer Tools"
        >
          &lt;/&gt;
        </button>
      </div>

      {/* Center title */}
      <span className="titlebar__title">{title ?? ''}</span>

      {/* Right spacer — leave room for native Windows controls (~140px) */}
      <div className="titlebar__right" />
    </div>
  );
}
