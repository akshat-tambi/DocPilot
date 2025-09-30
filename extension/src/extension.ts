import * as vscode from 'vscode';

import type { IngestionJobConfig, WorkerEventMessage } from '@docpilot/shared';

import { WorkerManager } from './workerManager';
import { CopilotBridge } from './copilotBridge';

let workerManager: WorkerManager | null = null;
let copilotBridge: CopilotBridge | null = null;
let activeJobId: string | null = null;

export function activate(context: vscode.ExtensionContext): void {
  workerManager = new WorkerManager(context);
  context.subscriptions.push(workerManager);

  workerManager.on('message', handleWorkerMessage);
  workerManager.on('error', handleWorkerError);
  workerManager.on('exit', handleWorkerExit);

  // Initialize Copilot bridge
  copilotBridge = new CopilotBridge(
    async (query: string) => {
      if (!workerManager) {
        throw new Error('Worker manager not available');
      }
      
      const result = await workerManager.query(query);
      return {
        chunks: result.chunks.map(chunk => ({
          chunk: {
            text: chunk.text,
            wordCount: chunk.text.split(' ').length
          },
          score: chunk.score,
          url: chunk.url,
          headings: chunk.headings
        })),
        totalFound: result.totalFound,
        queryTime: result.queryTime
      };
    },
    vscode.window.createOutputChannel('DocPilot Copilot')
  );

  copilotBridge.register(context);

  const startCommand = vscode.commands.registerCommand('docpilot.ingestUrl', async () => {
    if (!workerManager) {
      vscode.window.showErrorMessage('DocPilot worker is not available.');
      return;
    }

    const url = await vscode.window.showInputBox({
      prompt: 'Enter the documentation URL to ingest',
      placeHolder: 'https://docs.example.com',
      validateInput: (value) => {
        try {
          if (!value.trim()) {
            return 'Please provide a URL.';
          }
          new URL(value.trim());
          return null;
        } catch (error) {
          return error instanceof Error ? error.message : 'Invalid URL';
        }
      }
    });

    if (!url) {
      return;
    }

    const jobId = `docpilot-${Date.now()}`;
    const config: IngestionJobConfig = {
      jobId,
      seedUrls: [url.trim()],
      maxDepth: 2,
      maxPages: 25,
      followExternal: false
    };

    try {
      await workerManager.startIngestion(config);
      activeJobId = jobId;
      vscode.window.showInformationMessage(`DocPilot ingestion started for ${url}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to start ingestion: ${message}`);
    }
  });

  const cancelCommand = vscode.commands.registerCommand('docpilot.cancelIngestion', async () => {
    if (!workerManager) {
      vscode.window.showErrorMessage('DocPilot worker is not available.');
      return;
    }

    if (!activeJobId) {
      vscode.window.showInformationMessage('No active DocPilot ingestion job to cancel.');
      return;
    }

    await workerManager.cancel(activeJobId);
    vscode.window.showInformationMessage(`Cancellation requested for job ${activeJobId}.`);
  });

  context.subscriptions.push(startCommand, cancelCommand);
}

export function deactivate(): void {
  workerManager?.dispose();
  workerManager = null;
  copilotBridge = null;
  activeJobId = null;
}

function handleWorkerMessage(event: WorkerEventMessage): void {
  if (event.type === 'job-status') {
    if (event.payload.status === 'completed') {
      vscode.window.showInformationMessage(
        `DocPilot ingestion completed: ${event.payload.processedPages} pages processed.`
      );
      activeJobId = null;
      return;
    }

    if (event.payload.status === 'cancelled' || event.payload.status === 'error') {
      const reason = event.payload.error ? ` (${event.payload.error})` : '';
      vscode.window.showWarningMessage(
        `DocPilot ingestion ${event.payload.status}${reason}`
      );
      activeJobId = null;
    }

    return;
  }

  if (event.type === 'worker-error') {
    vscode.window.showErrorMessage(`DocPilot worker error: ${event.payload.message}`);
  }
}

function handleWorkerError(error: Error): void {
  vscode.window.showErrorMessage(`DocPilot worker failed: ${error.message}`);
  activeJobId = null;
}

function handleWorkerExit(code: number | null): void {
  const status = code === 0 ? 'stopped' : `exited with code ${code}`;
  vscode.window.showWarningMessage(`DocPilot worker ${status}.`);
  activeJobId = null;
}
