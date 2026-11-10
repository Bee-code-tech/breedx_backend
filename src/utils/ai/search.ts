import { Types } from 'mongoose';
import MaterialChunk from '../../models/materialChunk.model';
import { embed, TokenCount } from './vertex';

/** The Atlas Vector Search index on materialchunks (see scripts/create-ai-indexes.ts). */
export const VECTOR_INDEX = 'chunk_vector';

export interface ChunkHit {
  material: Types.ObjectId;
  text: string;
  pageStart: number;
  pageEnd: number;
  chapterTitle: string;
  topicTitle: string;
  score: number;
}

/** Finds the passages closest in meaning to `query` among the given materials. */
export const searchChunks = async (
  query: string,
  materialIds: Types.ObjectId[],
  limit: number,
  signal?: AbortSignal
): Promise<{ hits: ChunkHit[]; tokens: TokenCount }> => {
  const { vectors, tokens } = await embed([query], 'RETRIEVAL_QUERY', { signal });

  const hits = await MaterialChunk.aggregate<ChunkHit>([
    {
      $vectorSearch: {
        index: VECTOR_INDEX,
        path: 'embedding',
        queryVector: vectors[0],
        numCandidates: Math.min(limit * 25, 1000),
        limit,
        filter: { material: { $in: materialIds } },
      },
    },
    {
      $project: {
        _id: 0,
        material: 1,
        text: 1,
        pageStart: 1,
        pageEnd: 1,
        chapterTitle: 1,
        topicTitle: 1,
        score: { $meta: 'vectorSearchScore' },
      },
    },
  ]);

  return { hits, tokens };
};
