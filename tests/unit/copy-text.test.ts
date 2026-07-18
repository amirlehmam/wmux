import { describe, it, expect } from 'vitest';
import { trimTrailingWhitespace } from '../../src/renderer/utils/copy-text';

describe('trimTrailingWhitespace (issue #102)', () => {
  it('strips trailing spaces from every line', () => {
    expect(trimTrailingWhitespace('foo   \nbar \nbaz')).toBe('foo\nbar\nbaz');
  });

  it('strips trailing tabs', () => {
    expect(trimTrailingWhitespace('foo\t\t\nbar\t')).toBe('foo\nbar');
  });

  it('strips trailing whitespace on the last line without a newline', () => {
    expect(trimTrailingWhitespace('single line   ')).toBe('single line');
  });

  it('preserves CRLF line endings', () => {
    expect(trimTrailingWhitespace('foo  \r\nbar  \r\nbaz')).toBe('foo\r\nbar\r\nbaz');
  });

  it('preserves leading whitespace (indentation)', () => {
    expect(trimTrailingWhitespace('  indented   \n    more  ')).toBe('  indented\n    more');
  });

  it('leaves empty lines intact', () => {
    expect(trimTrailingWhitespace('foo\n\nbar')).toBe('foo\n\nbar');
  });

  it('collapses whitespace-only lines to empty lines', () => {
    expect(trimTrailingWhitespace('foo\n    \nbar')).toBe('foo\n\nbar');
  });

  it('returns empty string unchanged', () => {
    expect(trimTrailingWhitespace('')).toBe('');
  });

  it('does not touch interior whitespace', () => {
    expect(trimTrailingWhitespace('foo  bar  \n')).toBe('foo  bar\n');
  });
});
