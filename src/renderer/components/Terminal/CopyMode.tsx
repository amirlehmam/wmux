import { useT } from '../../i18n';

interface CopyModeProps {
  active: boolean;
}

export default function CopyMode({ active }: CopyModeProps) {
  const t = useT();
  if (!active) return null;
  return (
    <div className="copy-mode-indicator">
      {t('terminal.copyModeHint', 'COPY MODE — Arrow keys to move, Shift+arrows to select, Enter to copy, Esc to exit')}
    </div>
  );
}
