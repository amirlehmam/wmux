interface NotificationRingProps {
  visible: boolean;
  flashing: boolean; // true when just fired, false when steady glow
  accent?: 'blue' | 'teal';
}

export default function NotificationRing({ visible, flashing, accent = 'blue' }: NotificationRingProps) {
  if (!visible) return null;

  const color = accent === 'blue' ? '#007AFF' : '#5AC8FA';
  const glowOpacity = accent === 'blue' ? 0.6 : 0.14;
  const glowRadius = accent === 'blue' ? 6 : 3;

  return (
    <div
      className={`notification-ring ${flashing ? 'notification-ring--flashing' : ''}`}
      style={{
        borderColor: color,
        boxShadow: `0 0 ${glowRadius}px rgba(${accent === 'blue' ? '0,122,255' : '90,200,250'},${glowOpacity})`,
      }}
    />
  );
}
