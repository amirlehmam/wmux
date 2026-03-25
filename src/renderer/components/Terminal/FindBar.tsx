import { useState, useRef, useEffect } from 'react';

interface FindBarProps {
  onSearch: (query: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
  matchCount?: number;
  currentMatch?: number;
}

export default function FindBar({ onSearch, onNext, onPrevious, onClose, matchCount, currentMatch }: FindBarProps) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    onSearch(query);
  }, [query, onSearch]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); e.stopPropagation(); }
    if (e.key === 'Enter') { e.shiftKey ? onPrevious() : onNext(); }
  };

  return (
    <div className="find-bar">
      <input
        ref={inputRef}
        className="find-bar__input"
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find..."
      />
      {matchCount !== undefined && (
        <span className="find-bar__count">{currentMatch ?? 0}/{matchCount}</span>
      )}
      <button className="find-bar__btn" onClick={onPrevious} title="Previous (Shift+Enter)">&#x2191;</button>
      <button className="find-bar__btn" onClick={onNext} title="Next (Enter)">&#x2193;</button>
      <button className="find-bar__btn" onClick={onClose} title="Close (Esc)">&#x00D7;</button>
    </div>
  );
}
