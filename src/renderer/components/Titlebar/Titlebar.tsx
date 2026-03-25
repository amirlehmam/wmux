import React from 'react';
import logoSrc from '../../assets/logo.png';
import '../../styles/titlebar.css';

interface TitlebarProps {
  title?: string;
  onHelpClick?: () => void;
  onDevToolsClick?: () => void;
}

export default function Titlebar({ title, onHelpClick, onDevToolsClick }: TitlebarProps) {
  return (
    <div className="titlebar">
      <div className="titlebar__left">
        <img src={logoSrc} alt="wmux" className="titlebar__logo" draggable={false} />
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

      <span className="titlebar__title">{title ?? ''}</span>

      <div className="titlebar__right" />
    </div>
  );
}
