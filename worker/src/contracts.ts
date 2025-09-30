import type { TextChunk } from '@docpilot/shared';

export interface IngestionJobConfig {
  jobId: string;
  seedUrls: string[];
  maxDepth: number;
  maxPages: number;
  followExternal: boolean;
  allowedDomains?: string[];
  userAgent?: string;
  tokensPerChunk?: number;
  overlapTokens?: number;
  minTokensPerChunk?: number;
  concurrency?: number;
}

export interface CancelJobPayload {
  jobId: string;
}

export type WorkerControlMessage =
  | { type: 'start'; payload: IngestionJobConfig }
  | { type: 'cancel'; payload: CancelJobPayload };

export type PageLifecycleStatus =
  | 'queued'
  | 'fetching'
  | 'parsed'
  | 'skipped'
  | 'failed';

export interface PageProgressPayload {
  jobId: string;
  url: string;
  depth: number;
  status: PageLifecycleStatus;
  reason?: string;
}

export interface ChunkSummary {
  totalChunks: number;
  totalWords: number;
  totalCharacters: number;
}

export interface PageResultPayload {
  jobId: string;
  url: string;
  depth: number;
  headings: string[];
  rawText: string;
  chunks: TextChunk[];
  summary: ChunkSummary;
}

export type JobStatus = 'idle' | 'running' | 'completed' | 'cancelled' | 'error';

export interface JobStatusPayload {
  jobId: string;
  status: JobStatus;
  processedPages: number;
  discoveredPages: number;
  error?: string;
}

export interface WorkerErrorPayload {
  message: string;
}

export type WorkerEventMessage =
  | { type: 'page-progress'; payload: PageProgressPayload }
  | { type: 'page-result'; payload: PageResultPayload }
  | { type: 'job-status'; payload: JobStatusPayload }
  | { type: 'worker-error'; payload: WorkerErrorPayload };

export function isWorkerControlMessage(message: unknown): message is WorkerControlMessage {
  if (!message || typeof message !== 'object') {
    return false;
  }

  const value = message as { type?: unknown };
  if (value.type === 'start') {
    return true;
  }

  return value.type === 'cancel';
}