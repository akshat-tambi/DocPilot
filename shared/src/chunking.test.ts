import { describe, expect, it } from 'vitest';

import { chunkText, normalizeText, summarizeChunks } from './chunking';

const jobContext = {
  jobId: 'job-123',
  url: 'https://example.com/docs'
};

describe('normalizeText', () => {
  it('collapses whitespace and trims text', () => {
    const input = 'Hello\n\nworld\tfrom\r\nDocPilot';
    expect(normalizeText(input)).toBe('Hello world from DocPilot');
  });
});

describe('chunkText', () => {
  it('returns an empty array when text is blank', () => {
    expect(chunkText('', jobContext)).toEqual([]);
  });

  it('respects chunk and overlap sizes', () => {
    const words = Array.from({ length: 240 }, (_, index) => `word${index}`).join(' ');

    const chunks = chunkText(words, {
      ...jobContext,
      tokensPerChunk: 100,
      overlapTokens: 20
    });

    expect(chunks).toHaveLength(3);
    expect(chunks[0].wordCount).toBe(100);
    expect(chunks[1].wordCount).toBe(100);
    expect(chunks[0].text.split(' ').slice(-20)).toEqual(chunks[1].text.split(' ').slice(0, 20));
    expect(chunks[1].text.split(' ').slice(-20)).toEqual(chunks[2].text.split(' ').slice(0, 20));
  });

  it('avoids tiny trailing chunks', () => {
    const words = Array.from({ length: 120 }, (_, index) => `token${index}`).join(' ');

    const chunks = chunkText(words, {
      ...jobContext,
      tokensPerChunk: 100,
      overlapTokens: 10,
      minTokensPerChunk: 50
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].wordCount).toBe(120);
  });
});

describe('summarizeChunks', () => {
  it('computes totals across chunks', () => {
    const chunks = chunkText('one two three four five six seven eight nine ten', {
      ...jobContext,
      tokensPerChunk: 5,
      overlapTokens: 2
    });

    const summary = summarizeChunks(chunks);
    expect(summary.totalChunks).toBe(chunks.length);
    expect(summary.totalWords).toBe(
      chunks.reduce((acc, chunk) => acc + chunk.wordCount, 0)
    );
    expect(summary.totalCharacters).toBe(
      chunks.reduce((acc, chunk) => acc + chunk.charCount, 0)
    );
  });
});
