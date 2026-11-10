import { IMaterial, PageUnit, ProcessingProgress } from '../../types/library';
import { Stream } from '../sse';
import { MaterialNotReadyError, prepareMaterial } from './process';

// Files read at the same time when several need their first read
const PREPARE_PARALLEL = 2;

export const UNIT_NAMES: Record<PageUnit, string> = { page: 'pages', slide: 'slides', section: 'sections' };

/** The thought line shown while a file is read for the first time. */
const progressText = (name: string, progress: ProcessingProgress, unit: PageUnit = 'page') => {
  switch (progress.stage) {
    case 'reading':
      return `Opening ${name}…`;
    case 'scanning':
      return `Reading scanned ${UNIT_NAMES[unit]} in ${name} (${progress.done}/${progress.total})…`;
    case 'mapping':
      return `Mapping the chapters in ${name}…`;
    case 'indexing':
      return `Indexing ${name} (${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%)…`;
  }
};

/**
 * Reads every file that the AI hasn't read yet, showing progress as steps.
 * Returns the ids of materials that are ready to use.
 */
export const prepareAll = async (
  stream: Stream,
  userId: string,
  files: { material: string; name: string; status: IMaterial['status'] | undefined }[]
): Promise<Set<string>> => {
  const ready = new Set(files.filter((file) => file.status === 'ready').map((file) => file.material));
  const pending = files.filter((file) => file.status !== 'ready');

  const prepareOne = async (file: (typeof pending)[number]) => {
    const stepId = `prepare-${file.material}`;
    stream.step(stepId, `Reading ${file.name} for the first time…`, { status: 'active' });
    try {
      const material = await prepareMaterial(file.material, {
        fileName: file.name,
        userId,
        onProgress: (progress) => stream.step(stepId, progressText(file.name, progress), { status: 'active' }),
      });
      ready.add(file.material);
      const pages = material.pageCount ?? 0;
      stream.step(stepId, `Read ${file.name} (${pages} ${UNIT_NAMES[material.pageUnit]})`, { status: 'done' });
    } catch (error) {
      const message = error instanceof MaterialNotReadyError ? error.message : "We couldn't read this file.";
      stream.step(stepId, `Skipped ${file.name}: ${message}`, { status: 'skipped' });
    }
  };

  for (let i = 0; i < pending.length; i += PREPARE_PARALLEL) {
    await Promise.all(pending.slice(i, i + PREPARE_PARALLEL).map(prepareOne));
  }
  return ready;
};
