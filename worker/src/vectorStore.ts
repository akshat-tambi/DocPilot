import type { TextChunk } from '@docpilot/shared';

export interface VectorDocument {
  id: string;
  jobId: string;
  url: string;
  chunkIndex: number;
  text: string;
  headings: string[];
  vector: number[];
  metadata: Record<string, any>;
}

export interface SearchResult {
  document: VectorDocument;
  score: number;
}

interface StoredVector {
  id: string;
  vector: Float32Array;
  document: VectorDocument;
}

export class VectorStore {
  private vectors: StoredVector[] = [];
  private storagePath: string | null = null;

  public async initialize(storagePath?: string): Promise<void> {
    try {
      this.storagePath = storagePath || null;
      if (storagePath) {
        console.log(`Vector store initialized for path: ${storagePath}`);
      }
      console.log('In-memory vector store initialized');
    } catch (error) {
      throw new Error(`Failed to initialize vector store: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async addChunks(jobId: string, url: string, chunks: TextChunk[], vectors: Float32Array[]): Promise<void> {
    if (chunks.length !== vectors.length) {
      throw new Error('Chunks and vectors array length mismatch');
    }

    try {
      chunks.forEach((chunk, index) => {
        const document: VectorDocument = {
          id: `${jobId}_${chunk.id}`,
          jobId,
          url,
          chunkIndex: index,
          text: chunk.text,
          headings: chunk.headingPath || [],
          vector: Array.from(vectors[index]),
          metadata: {
            chunkId: chunk.id,
            wordCount: chunk.wordCount,
            charCount: chunk.charCount,
            createdAt: chunk.createdAt
          }
        };

        this.vectors.push({
          id: document.id,
          vector: vectors[index],
          document
        });
      });
    } catch (error) {
      throw new Error(`Failed to add chunks to vector store: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async search(queryVector: Float32Array, limit: number = 10, jobIds?: string[]): Promise<SearchResult[]> {
    try {
      let candidateVectors = this.vectors;
      if (jobIds && jobIds.length > 0) {
        candidateVectors = this.vectors.filter(v => jobIds.includes(v.document.jobId));
      }

      const results: SearchResult[] = candidateVectors.map(stored => {
        const similarity = this.cosineSimilarity(queryVector, stored.vector);
        return {
          document: stored.document,
          score: similarity
        };
      });

      return results
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    } catch (error) {
      throw new Error(`Failed to search vector store: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async clearJob(jobId: string): Promise<void> {
    try {
      this.vectors = this.vectors.filter(v => v.document.jobId !== jobId);
    } catch (error) {
      throw new Error(`Failed to clear job from vector store: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async getCollectionInfo(): Promise<{ count: number; metadata: Record<string, any> }> {
    try {
      return {
        count: this.vectors.length,
        metadata: {
          description: 'DocPilot documentation chunks (in-memory)',
          created: new Date().toISOString(),
          storagePath: this.storagePath
        }
      };
    } catch (error) {
      throw new Error(`Failed to get collection info: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public dispose(): void {
    this.vectors = [];
    this.storagePath = null;
  }

  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
      throw new Error('Vector dimensions must match');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    if (magnitude === 0) {
      return 0;
    }

    return dotProduct / magnitude;
  }
}
