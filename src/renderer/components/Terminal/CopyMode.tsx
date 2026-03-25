interface CopyModeProps {
  active: boolean;
}

export default function CopyMode({ active }: CopyModeProps) {
  if (!active) return null;
  return (
    <div className="copy-mode-indicator">COPY MODE — Arrow keys to move, Shift+arrows to select, Enter to copy, Esc to exit</div>
  );
}
