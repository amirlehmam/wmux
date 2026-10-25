import { describe, it, expect } from 'vitest';
import { readScreenParams } from '../../src/cli/wmux';

/**
 * `wmux read-screen` argv → the `surface.read_text` params. `--events` asks for
 * the per-surface history of buffer switches and resizes (see
 * renderer/utils/screen-report.ts); it is opt-in because agents call
 * read-screen constantly and only a diagnosis wants the history.
 */
describe('readScreenParams', () => {
  it('defaults to the caller\'s own surface and 50 lines, without the event history', () => {
    expect(readScreenParams(['read-screen'], 'surf-self')).toEqual({ surfaceId: 'surf-self', lines: 50 });
  });

  it('takes --surface over the caller and --lines as a number', () => {
    expect(readScreenParams(['read-screen', '--surface', 'surf-x', '--lines', '200'], 'surf-self'))
      .toEqual({ surfaceId: 'surf-x', lines: 200 });
  });

  it('asks for the event history only with --events', () => {
    expect(readScreenParams(['read-screen', '--events'], undefined)).toEqual({ lines: 50, events: true });
  });
});
