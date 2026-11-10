// Creates the Atlas Vector Search index the AI searches with. Safe to run
// again: it leaves an existing index alone. Run once per database:
//   npm run ai:indexes
import mongoose from 'mongoose';
import env from '../config/env';
import MaterialChunk from '../models/materialChunk.model';
import { VECTOR_INDEX } from '../utils/ai/search';
import { EMBED_DIMENSIONS } from '../utils/ai/vertex';

const main = async () => {
  await mongoose.connect(env.MONGODB_URI);
  await MaterialChunk.createCollection();
  const collection = MaterialChunk.collection;

  const existing = await collection.listSearchIndexes(VECTOR_INDEX).toArray();
  if (existing.length) {
    console.log(`"${VECTOR_INDEX}" already exists (status: ${(existing[0] as { status?: string }).status})`);
  } else {
    await collection.createSearchIndex({
      name: VECTOR_INDEX,
      type: 'vectorSearch',
      definition: {
        fields: [
          { type: 'vector', path: 'embedding', numDimensions: EMBED_DIMENSIONS, similarity: 'cosine' },
          { type: 'filter', path: 'material' },
        ],
      },
    });
    console.log(`Created "${VECTOR_INDEX}". Atlas takes a minute or two to build it.`);
  }
  await mongoose.disconnect();
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
