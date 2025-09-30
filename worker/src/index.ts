import * as path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

import { IngestionWorker } from './ingestionWorker';

type WorkerBootstrapData = {
  additionalNodePaths?: string[];
  isPackaged?: boolean;
};

function registerAdditionalModulePaths(): void {
  const data = (workerData ?? {}) as WorkerBootstrapData;
  const additionalPaths = data.additionalNodePaths ?? [];
  if (additionalPaths.length === 0) {
    return;
  }

  const Module = require('module') as {
    globalPaths: string[];
    _initPaths: () => void;
  };

  const resolved = additionalPaths.map((entry) => path.resolve(entry));
  const existingNodePath = process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter) : [];
  const combined = [...new Set([...resolved, ...existingNodePath])];
  process.env.NODE_PATH = combined.join(path.delimiter);

  for (const entry of resolved.reverse()) {
    if (!Module.globalPaths.includes(entry)) {
      Module.globalPaths.unshift(entry);
    }
  }

  Module._initPaths();
}

async function bootstrap(): Promise<void> {
  registerAdditionalModulePaths();

  const port = parentPort;
  if (!port) {
    console.error('DocPilot worker started without a parent port; exiting');
    process.exit(1);
  }

  const worker = new IngestionWorker(port);
  await worker.bind();

  process.on('uncaughtException', (error) => {
    console.error('Uncaught exception in ingestion worker', error);
    port.postMessage({ type: 'worker-error', payload: { message: error.message } });
  });

  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection in ingestion worker', reason);
    port.postMessage({
      type: 'worker-error',
      payload: { message: reason instanceof Error ? reason.message : String(reason) }
    });
  });
}

bootstrap();
