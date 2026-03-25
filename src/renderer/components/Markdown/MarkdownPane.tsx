import { useMemo } from 'react';
import { marked } from 'marked';
import '../../styles/markdown.css';

interface MarkdownPaneProps {
  content?: string;
  surfaceId: string;
}

export default function MarkdownPane({ content = '', surfaceId }: MarkdownPaneProps) {
  const html = useMemo(() => {
    if (!content) return '<p style="opacity: 0.5">No content. Use wmux markdown set to add content.</p>';

    marked.setOptions({
      gfm: true,
      breaks: true,
    });

    return marked.parse(content) as string;
  }, [content]);

  return (
    <div className="markdown-pane" data-surface-id={surfaceId}>
      <div
        className="markdown-pane__content"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
