// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keepPaneFocus } from '../../src/renderer/components/Sidebar/keep-pane-focus';

/**
 * A click in the sidebar must not strand the keyboard outside the focused
 * pane, and must not cost a workspace row its native drag.
 */
describe('keepPaneFocus', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  function setup() {
    document.body.innerHTML = `
      <div class="pane-wrapper pane-wrapper--focused"><textarea id="term"></textarea></div>
      <div class="pane-wrapper"><textarea id="other"></textarea></div>
      <div class="sidebar">
        <div id="row" draggable="true"><span id="label">ws</span><input id="rename"></div>
        <button id="footer">save</button>
      </div>`;
    const term = document.getElementById('term') as HTMLTextAreaElement;
    term.focus();
    return { term, byId: (id: string) => document.getElementById(id) as HTMLElement };
  }

  function press(target: HTMLElement) {
    const e = { target, preventDefault: vi.fn() };
    keepPaneFocus(e);
    return e;
  }

  it('cancels the focus change of a press outside the rows', () => {
    const { byId } = setup();
    expect(press(byId('footer')).preventDefault).toHaveBeenCalled();
  });

  it('leaves text fields their focus', () => {
    const { byId } = setup();
    expect(press(byId('rename')).preventDefault).not.toHaveBeenCalled();
  });

  it('keeps a row draggable and hands focus back once the press ends', () => {
    vi.useFakeTimers();
    const { term, byId } = setup();
    expect(press(byId('label')).preventDefault).not.toHaveBeenCalled();
    term.blur();
    window.dispatchEvent(new MouseEvent('mouseup'));
    vi.runAllTimers();
    expect(document.activeElement).toBe(term);
  });

  it('does not take focus back when the click moved it to another pane', () => {
    vi.useFakeTimers();
    const { byId } = setup();
    press(byId('label'));
    byId('other').focus();
    window.dispatchEvent(new Event('dragend'));
    vi.runAllTimers();
    expect(document.activeElement).toBe(byId('other'));
  });
});
