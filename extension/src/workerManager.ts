import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';

import type { ExtensionContext, OutputChannel } from 'vscode';
import * as vscode from 'vscode';

import type { IngestionJobConfig, WorkerEventMessage, WorkerControlMessage } from '@docpilot/shared';

export type WorkerManagerEvents = {
  message: (event: WorkerEventMessage) => void;
  error: (error: Error) => void;
  exit: (code: number | null) => void;
};

export class WorkerManager extends EventEmitter implements vscode.Disposable {
  private worker: Worker | null = null;
  private readonly output: OutputChannel;

  constructor(private readonly context: ExtensionContext) {
    super();
    this.output = vscode.window.createOutputChannel('DocPilot Worker');
  }

  public override on<K extends keyof WorkerManagerEvents>(
    event: K,
    listener: WorkerManagerEvents[K]
  ): this {
    return super.on(event, listener);
  }

  public override once<K extends keyof WorkerManagerEvents>(
    event: K,
    listener: WorkerManagerEvents[K]
  ): this {
    return super.once(event, listener);
  }

  public override off<K extends keyof WorkerManagerEvents>(
    event: K,
    listener: WorkerManagerEvents[K]
  ): this {
    return super.off(event, listener);
  }

  public async ensureWorker(): Promise<void> {
    if (this.worker) {
      return;
    }

  const workerEntry = path.join(this.context.extensionPath, '..', 'worker', 'dist', 'index.js');

    this.output.appendLine(`[docpilot] starting worker: ${workerEntry}`);

    this.worker = new Worker(workerEntry, {
      execArgv: process.env.DOCPILOT_ENABLE_SOURCE_MAPS ? ['--enable-source-maps'] : []
    });

    this.worker.on('message', (event: WorkerEventMessage) => {
      this.emit('message', event);
      this.logWorkerEvent(event);
    });

    this.worker.on('error', (error) => {
      this.output.appendLine(`[docpilot] worker error: ${error.message}`);
      this.emit('error', error);
      this.disposeWorker();
    });

    this.worker.on('exit', (code) => {
      this.output.appendLine(`[docpilot] worker exited with code ${code}`);
      this.emit('exit', code ?? null);
      this.disposeWorker();
    });
  }

  public async startIngestion(config: IngestionJobConfig): Promise<void> {
    await this.ensureWorker();

    if (!this.worker) {
      throw new Error('Worker failed to start');
    }

  const message: WorkerControlMessage = { type: 'start', payload: config };
  this.worker.postMessage(message);
  }

  public async cancel(jobId: string): Promise<void> {
    if (!this.worker) {
      return;
    }

  const message: WorkerControlMessage = { type: 'cancel', payload: { jobId } };
  this.worker.postMessage(message);
  }

  public dispose(): void {
    this.disposeWorker();
    this.output.dispose();
  }

  private logWorkerEvent(event: WorkerEventMessage): void {
    if (event.type === 'worker-error') {
      this.output.appendLine(`[worker] error: ${event.payload.message}`);
      return;
    }

    if (event.type === 'job-status') {
      this.output.appendLine(
        `[worker] job ${event.payload.jobId} status ${event.payload.status} (processed=${event.payload.processedPages}, discovered=${event.payload.discoveredPages})`
      );
      return;
    }

    if (event.type === 'page-progress') {
      this.output.appendLine(
        `[worker] page ${event.payload.url} depth=${event.payload.depth} status=${event.payload.status} ${event.payload.reason ?? ''}`
      );
      return;
    }

    if (event.type === 'page-result') {
      this.output.appendLine(
        `[worker] page result ${event.payload.url} chunks=${event.payload.chunks.length} words=${event.payload.summary.totalWords}`
      );
    }
  }

  private disposeWorker(): void {
    if (this.worker) {
      this.worker.terminate().catch(() => {
        // ignore terminate errors during disposal
      });
      this.worker.removeAllListeners();
      this.worker = null;
    }
  }
}
