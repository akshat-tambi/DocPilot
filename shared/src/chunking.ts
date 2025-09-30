import { nanoid } from 'nanoid';

export interface ChunkContext {
  jobId: string;
  url: string;
  headingPath?: string[];
  createdAt?: Date;
}

export interface ChunkingOptions extends ChunkContext {
  tokensPerChunk?: number;
  overlapTokens?: number;
  minTokensPerChunk?: number;
}

export interface TextChunk {
  id: string;
  jobId: string;
  url: string;
  order: number;
  headingPath: string[];
  text: string;
  wordCount: number;
  charCount: number;
  createdAt: string;
}

const DEFAULT_TOKENS_PER_CHUNK = 800;
const DEFAULT_OVERLAP_TOKENS = 160; // 20%
const MIN_TOKENS_PER_CHUNK = 80;

const whitespaceRegex = /\s+/g;

export function normalizeText(rawText: string): string {
  return rawText.replace(/\r\n|\r/g, '\n').replace(whitespaceRegex, ' ').trim();
}

export function chunkText(rawText: string, options: ChunkingOptions): TextChunk[] {
  const normalized = normalizeText(rawText);

  if (!normalized) {
    return [];
  }

  const tokens = normalized.split(' ').filter(Boolean);
  if (tokens.length === 0) {
    return [];
  }

  const tokensPerChunk = Math.max(
    options.tokensPerChunk ?? DEFAULT_TOKENS_PER_CHUNK,
    options.minTokensPerChunk ?? MIN_TOKENS_PER_CHUNK
  );

  const overlapTokens = Math.min(
    options.overlapTokens ?? DEFAULT_OVERLAP_TOKENS,
    Math.max(tokensPerChunk - 1, 0)
  );

  const headingPath = options.headingPath ?? [];
  const createdAt = (options.createdAt ?? new Date()).toISOString();

  const chunks: TextChunk[] = [];
  const step = Math.max(tokensPerChunk - overlapTokens, 1);

  for (let start = 0, order = 0; start < tokens.length; start += step, order += 1) {
    const end = Math.min(tokens.length, start + tokensPerChunk);
    const slice = tokens.slice(start, end);

    if (slice.length < (options.minTokensPerChunk ?? MIN_TOKENS_PER_CHUNK) && chunks.length > 0) {
      const previous = chunks[chunks.length - 1];
      const uniqueSlice = slice.slice(Math.min(overlapTokens, slice.length));

      if (uniqueSlice.length > 0) {
        previous.text = `${previous.text} ${uniqueSlice.join(' ')}`.trim();
        previous.wordCount += uniqueSlice.length;
        previous.charCount = previous.text.length;
      }

      break;
    }

    const text = slice.join(' ');

    chunks.push({
      id: nanoid(10),
      jobId: options.jobId,
      url: options.url,
      order,
      headingPath,
      text,
      wordCount: slice.length,
      charCount: text.length,
      createdAt
    });
  }

  return chunks;
}

export function summarizeChunks(chunks: TextChunk[]): {
  totalChunks: number;
  totalWords: number;
  totalCharacters: number;
} {
  return chunks.reduce(
    (acc, chunk) => {
      acc.totalChunks += 1;
      acc.totalWords += chunk.wordCount;
      acc.totalCharacters += chunk.charCount;
      return acc;
    },
    { totalChunks: 0, totalWords: 0, totalCharacters: 0 }
  );
}

export const ChunkingDefaults = {
  tokensPerChunk: DEFAULT_TOKENS_PER_CHUNK,
  overlapTokens: DEFAULT_OVERLAP_TOKENS,
  minTokensPerChunk: MIN_TOKENS_PER_CHUNK
};
