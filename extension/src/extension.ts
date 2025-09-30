import * as vscode from 'vscode';

import type { IngestionJobConfig, WorkerEventMessage } from '@docpilot/shared';

import { WorkerManager } from './workerManager';
import { CopilotBridge } from './copilotBridge';

let workerManager: WorkerManager | null = null;
let copilotBridge: CopilotBridge | null = null;
let activeJobId: string | null = null;
let activeQueryStatus: vscode.Disposable | null = null;

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

  const queryCommand = vscode.commands.registerCommand('docpilot.queryDocs', async () => {
    if (!workerManager) {
      vscode.window.showErrorMessage('DocPilot worker is not available.');
      return;
    }

    const query = await vscode.window.showInputBox({
      prompt: 'Enter your documentation query',
      placeHolder: 'How do I authenticate with the API?',
      validateInput: (value) => {
        if (!value.trim()) {
          return 'Please enter a query.';
        }
        return null;
      }
    });

    if (!query) {
      return;
    }

    try {
      vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Searching documentation...',
        cancellable: false
      }, async () => {
        const result = await workerManager!.query(query.trim());
        
        if (result.chunks.length === 0) {
          vscode.window.showInformationMessage('No relevant documentation found for your query.');
          return;
        }

        const panel = vscode.window.createWebviewPanel(
          'docpilotResults',
          'DocPilot Search Results',
          vscode.ViewColumn.Beside,
          { enableScripts: false }
        );

        const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: var(--vscode-font-family); padding: 20px; }
            .result { margin-bottom: 20px; padding: 15px; border: 1px solid var(--vscode-panel-border); }
            .score { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
            .url { color: var(--vscode-textLink-foreground); text-decoration: none; }
            .text { margin-top: 10px; line-height: 1.6; }
            .heading { font-weight: bold; margin-bottom: 5px; }
          </style>
        </head>
        <body>
          <h2>📚 Documentation Search Results</h2>
          <p><strong>Query:</strong> ${query}</p>
          <p><strong>Found:</strong> ${result.totalFound} results in ${result.queryTime}ms</p>
          ${result.chunks.map((chunk, index) => `
            <div class="result">
              <div class="heading">${index + 1}. ${chunk.headings.join(' > ') || 'Documentation'}</div>
              <div class="score">Score: ${(chunk.score * 100).toFixed(1)}% | <a href="${chunk.url}" class="url">${chunk.url}</a></div>
              <div class="text">${chunk.text.substring(0, 500)}${chunk.text.length > 500 ? '...' : ''}</div>
            </div>
          `).join('')}
        </body>
        </html>`;

        panel.webview.html = html;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Documentation query failed: ${message}`);
    }
  });

  context.subscriptions.push(startCommand, cancelCommand, queryCommand);
}

export function deactivate(): void {
  workerManager?.dispose();
  workerManager = null;
  copilotBridge = null;
  activeJobId = null;
  if (activeQueryStatus) {
    activeQueryStatus.dispose();
    activeQueryStatus = null;
  }
}

function handleWorkerMessage(event: WorkerEventMessage): void {
  if (event.type === 'query-status') {
    if (activeQueryStatus) {
      activeQueryStatus.dispose();
      activeQueryStatus = null;
    }

    const status = event.payload.status;
    const jobScope = event.payload.jobId ? `job ${event.payload.jobId}` : 'all jobs';
    let message: string;

    switch (status) {
      case 'started':
        message = `DocPilot: query started for ${jobScope}`;
        break;
      case 'retrieving':
        message = `DocPilot: retrieving candidates (${event.payload.retrievedCandidates ?? 0} found)`;
        break;
      case 'scoring':
        message = `DocPilot: scoring ${event.payload.consideredChunks} chunks`;
        break;
      case 'completed':
        message = `DocPilot: query completed with ${event.payload.totalResults} results in ${event.payload.durationMs}ms`;
        break;
      case 'cancelled':
        message = 'DocPilot: query cancelled';
        break;
      case 'failed':
        message = `DocPilot: query failed (${event.payload.error})`;
        break;
    }

    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      vscode.window.setStatusBarMessage(message, 5000);
    } else {
      activeQueryStatus = vscode.window.setStatusBarMessage(message);
    }

    return;
  }

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
    if (activeQueryStatus) {
      activeQueryStatus.dispose();
      activeQueryStatus = null;
    }
  }
}

function handleWorkerError(error: Error): void {
  vscode.window.showErrorMessage(`DocPilot worker failed: ${error.message}`);
  activeJobId = null;
  if (activeQueryStatus) {
    activeQueryStatus.dispose();
    activeQueryStatus = null;
  }
}

function handleWorkerExit(code: number | null): void {
  const status = code === 0 ? 'stopped' : `exited with code ${code}`;
  vscode.window.showWarningMessage(`DocPilot worker ${status}.`);
  activeJobId = null;
  if (activeQueryStatus) {
    activeQueryStatus.dispose();
    activeQueryStatus = null;
  }
}
