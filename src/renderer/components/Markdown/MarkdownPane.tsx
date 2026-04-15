import { useCallback, useMemo } from 'react';
import { marked } from 'marked';
import { SplitNode } from '../../../shared/types';
import { useStore } from '../../store';
import '../../styles/markdown.css';

interface MarkdownPaneProps {
  content?: string;
  surfaceId: string;
}

function treeHasSurface(node: SplitNode, surfaceId: string): boolean {
  if (node.type === 'leaf') return node.surfaces.some((surface) => surface.id === surfaceId);
  return treeHasSurface(node.children[0], surfaceId) || treeHasSurface(node.children[1], surfaceId);
}

const LINK_HINT = 'Click to open in wmux browser. Ctrl+Click opens your default browser.';

export default function MarkdownPane({ content = '', surfaceId }: MarkdownPaneProps) {
  const html = useMemo(() => {
    if (!content) return '<p style="opacity: 0.5">No content. Use wmux markdown set to add content.</p>';

    marked.setOptions({
      gfm: true,
      breaks: true,
    });

    return marked.parse(content) as string;
  }, [content]);

  const handleContentClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement | null)?.closest?.('a') as HTMLAnchorElement | null;
    const href = anchor?.href;
    if (!href) return;

    event.preventDefault();
    anchor.title = LINK_HINT;

    const state = useStore.getState();
    const workspace = state.workspaces.find((ws) => treeHasSurface(ws.splitTree, surfaceId));
    const openExternal = event.ctrlKey || event.metaKey;

    if (openExternal || !workspace || !workspace.browserOpen) {
      window.wmux?.system?.openExternal?.(href);
      return;
    }

    state.updateWorkspaceMetadata(workspace.id, {
      browserOpen: true,
      browserUrl: href,
    });
    window.wmux?.browser?.navigate?.(`browser-${workspace.id}`, href);
  }, [surfaceId]);

  return (
    <div className="markdown-pane" data-surface-id={surfaceId}>
      <div
        className="markdown-pane__content"
        onMouseOver={(event) => {
          const anchor = (event.target as HTMLElement | null)?.closest?.('a') as HTMLAnchorElement | null;
          if (anchor?.href) anchor.title = LINK_HINT;
        }}
        onClick={handleContentClick}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
