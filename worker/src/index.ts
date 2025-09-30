import { parentPort } from 'node:worker_threads';

import { IngestionWorker } from './ingestionWorker';

async function bootstrap(): Promise<void> {
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
