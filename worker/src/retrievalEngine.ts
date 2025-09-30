import type { TextChunk } from '@docpilot/shared';
import { EmbeddingEngine, type EmbeddingResult } from './embeddingEngine';
import { VectorStore, type SearchResult } from './vectorStore';

export interface RetrievalQuery {
  text: string;
  limit?: number;
  jobIds?: string[];
  threshold?: number;
}

export interface RetrievalResult {
  chunks: Array<{
    chunk: TextChunk;
    score: number;
    url: string;
    headings: string[];
  }>;
  totalFound: number;
  queryTime: number;
}

export class RetrievalEngine {
  private embeddingEngine: EmbeddingEngine;
  private vectorStore: VectorStore;
  private initialized = false;

  constructor(storagePath?: string) {
    this.embeddingEngine = new EmbeddingEngine();
    this.vectorStore = new VectorStore();
  }

  public async initialize(storagePath?: string): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      await Promise.all([
        this.embeddingEngine.initialize(),
        this.vectorStore.initialize(storagePath)
      ]);
      
      this.initialized = true;
    } catch (error) {
      throw new Error(`Failed to initialize retrieval engine: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async indexChunks(jobId: string, url: string, chunks: TextChunk[]): Promise<void> {
    if (!this.initialized) {
      throw new Error('Retrieval engine not initialized');
    }

    if (chunks.length === 0) {
      return;
    }

    try {
      // Extract text for embedding
      const texts = chunks.map(chunk => chunk.text);
      
      // Generate embeddings for all chunks
      const embeddings = await this.embeddingEngine.embedBatch(texts);
      const vectors = embeddings.map(emb => emb.vector);

      // Store in vector database
      await this.vectorStore.addChunks(jobId, url, chunks, vectors);
    } catch (error) {
      throw new Error(`Failed to index chunks: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async retrieve(query: RetrievalQuery): Promise<RetrievalResult> {
    if (!this.initialized) {
      throw new Error('Retrieval engine not initialized');
    }

    const startTime = Date.now();

    try {
      // Generate query embedding
      const queryEmbedding = await this.embeddingEngine.embed(query.text);
      
      // Search vector store
      const searchResults = await this.vectorStore.search(
        queryEmbedding.vector,
        query.limit || 10,
        query.jobIds
      );

      // Filter by threshold if specified
      const threshold = query.threshold || 0.1;
      const filteredResults = searchResults.filter(result => result.score >= threshold);

      // Convert to retrieval format
      const chunks = filteredResults.map(result => ({
        chunk: {
          id: result.document.metadata.chunkId,
          jobId: result.document.jobId,
          url: result.document.url,
          order: result.document.chunkIndex,
          headingPath: result.document.headings,
          text: result.document.text,
          wordCount: result.document.metadata.wordCount,
          charCount: result.document.metadata.charCount,
          createdAt: result.document.metadata.createdAt
        } as TextChunk,
        score: result.score,
        url: result.document.url,
        headings: result.document.headings
      }));

      return {
        chunks,
        totalFound: filteredResults.length,
        queryTime: Date.now() - startTime
      };
    } catch (error) {
      throw new Error(`Retrieval failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async deleteJob(jobId: string): Promise<void> {
    if (!this.initialized) {
      throw new Error('Retrieval engine not initialized');
    }

    try {
      await this.vectorStore.clearJob(jobId);
    } catch (error) {
      throw new Error(`Failed to delete job: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async getStats(): Promise<{ totalChunks: number; metadata: any }> {
    if (!this.initialized) {
      throw new Error('Retrieval engine not initialized');
    }

    try {
      const info = await this.vectorStore.getCollectionInfo();
      return {
        totalChunks: info.count,
        metadata: info.metadata
      };
    } catch (error) {
      throw new Error(`Failed to get stats: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public dispose(): void {
    this.embeddingEngine.dispose();
    this.vectorStore.dispose();
    this.initialized = false;
  }
}