import { ChromaClient, Collection, OpenAIEmbeddingFunction } from 'chromadb';
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

export class VectorStore {
  private client: ChromaClient | null = null;
  private collection: Collection | null = null;
  private readonly collectionName = 'docpilot_chunks';

  public async initialize(storagePath?: string): Promise<void> {
    try {
      this.client = new ChromaClient({
        path: storagePath || './chroma_db'
      });

      this.collection = await this.client.getOrCreateCollection({
        name: this.collectionName,
        metadata: { 
          description: 'DocPilot documentation chunks',
          created: new Date().toISOString()
        }
      });
    } catch (error) {
      throw new Error(`Failed to initialize vector store: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async addChunks(jobId: string, url: string, chunks: TextChunk[], vectors: Float32Array[]): Promise<void> {
    if (!this.collection) {
      throw new Error('Vector store not initialized');
    }

    if (chunks.length !== vectors.length) {
      throw new Error('Chunks and vectors array length mismatch');
    }

    try {
      const documents = chunks.map((chunk, index) => ({
        id: `${jobId}_${chunk.id}`,
        document: chunk.text,
        metadatas: {
          jobId,
          url,
          chunkIndex: index,
          chunkId: chunk.id,
          headings: JSON.stringify(chunk.headingPath || []),
          wordCount: chunk.wordCount,
          charCount: chunk.charCount,
          createdAt: chunk.createdAt
        },
        embeddings: Array.from(vectors[index])
      }));

      await this.collection.add({
        ids: documents.map(d => d.id),
        documents: documents.map(d => d.document),
        metadatas: documents.map(d => d.metadatas),
        embeddings: documents.map(d => d.embeddings)
      });
    } catch (error) {
      throw new Error(`Failed to add chunks to vector store: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async search(queryVector: Float32Array, limit: number = 10, jobIds?: string[]): Promise<SearchResult[]> {
    if (!this.collection) {
      throw new Error('Vector store not initialized');
    }

    try {
      const where = jobIds && jobIds.length > 0 ? { jobId: { $in: jobIds } } : undefined;

      const results = await this.collection.query({
        queryEmbeddings: [Array.from(queryVector)],
        nResults: limit,
        where
      });

      if (!results.ids || !results.documents || !results.metadatas || !results.distances) {
        return [];
      }

      return results.ids[0].map((id, index) => ({
        document: {
          id: id as string,
          jobId: (results.metadatas![0][index] as any).jobId,
          url: (results.metadatas![0][index] as any).url,
          chunkIndex: (results.metadatas![0][index] as any).chunkIndex,
          text: results.documents![0][index] as string,
          headings: JSON.parse((results.metadatas![0][index] as any).headings || '[]'),
          vector: [],
          metadata: results.metadatas![0][index] as Record<string, any>
        },
        score: 1 - (results.distances![0][index] as number) // Convert distance to similarity
      })).sort((a, b) => b.score - a.score);
    } catch (error) {
      throw new Error(`Vector search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async deleteByJobId(jobId: string): Promise<void> {
    if (!this.collection) {
      throw new Error('Vector store not initialized');
    }

    try {
      await this.collection.delete({
        where: { jobId }
      });
    } catch (error) {
      throw new Error(`Failed to delete job chunks: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async getCollectionInfo(): Promise<{ count: number; metadata: any }> {
    if (!this.collection) {
      throw new Error('Vector store not initialized');
    }

    try {
      const count = await this.collection.count();
      return {
        count,
        metadata: this.collection.metadata || {}
      };
    } catch (error) {
      throw new Error(`Failed to get collection info: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public dispose(): void {
    this.collection = null;
    this.client = null;
  }
}