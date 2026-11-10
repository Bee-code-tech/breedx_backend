import { Types } from 'mongoose';
import Library from '../../models/library.model';
import LibraryFile from '../../models/libraryFile.model';
import Material from '../../models/material.model';
import Space from '../../models/space.model';
import SpaceMember from '../../models/spaceMember.model';
import { ILibraryFile, IMaterial } from '../../types/library';
import { ISpaceMaterial } from '../../types/space';
import { Stream } from '../sse';
import { prepareAll } from './prepare';

/**
 * A file the AI can use. Library files are themselves; a space's course
 * material stands in as one, with `spaceSlug` set and `library` holding the
 * space's id, so answers can link back to it in the space.
 */
export type ScopeFile = ILibraryFile & { spaceSlug?: string };

/** A space's course materials to include: the whole space, some courses, or some materials. */
export interface SpaceScope {
  id: string | Types.ObjectId;
  courseIds?: (string | Types.ObjectId)[] | null;
  materialIds?: (string | Types.ObjectId)[] | null;
}

export interface Scope {
  /** One file per stored material: a file in several libraries is used once. */
  byMaterial: Map<string, ScopeFile>;
  libraryNames: Map<string, string>;
  materials: Map<string, IMaterial>;
}

/**
 * A space's course materials as AI files, when the student is a member. Only
 * finished uploads count; old name-only materials have nothing to read.
 */
const spaceFiles = async (userId: string, scope: SpaceScope) => {
  const member = await SpaceMember.exists({ space: scope.id, user: userId, status: 'active' });
  const space = member ? await Space.findById(scope.id).select('name slug courses').lean() : null;
  if (!space) return { files: [] as ScopeFile[], name: null as { id: string; name: string } | null };

  const courseIds = scope.courseIds?.length ? new Set(scope.courseIds.map(String)) : null;
  const materialIds = scope.materialIds?.length ? new Set(scope.materialIds.map(String)) : null;
  const files: ScopeFile[] = [];
  for (const course of space.courses ?? []) {
    if (courseIds && !courseIds.has(String(course._id))) continue;
    for (const material of (course.materials ?? []) as ISpaceMaterial[]) {
      if (material.status !== 'ready' || !material.material) continue;
      if (materialIds && !materialIds.has(String(material._id))) continue;
      files.push({
        _id: material._id,
        name: material.title,
        library: space._id,
        material: material.material,
        status: 'ready',
        spaceSlug: space.slug,
      } as unknown as ScopeFile);
    }
  }
  return { files, name: { id: String(space._id), name: space.name } };
};

/**
 * The files an AI request covers: the student's library files (the given
 * files, or every file in the given libraries), and/or a space's course
 * materials. With nothing chosen, everything in their libraries.
 */
export const resolveScope = async (
  userId: string,
  options: {
    libraryIds?: (string | Types.ObjectId)[] | null;
    fileIds?: (string | Types.ObjectId)[] | null;
    space?: SpaceScope | null;
  }
): Promise<Scope> => {
  const libraryIds = options.libraryIds?.length ? options.libraryIds : null;
  const fileIds = options.fileIds?.length ? options.fileIds : null;
  // A space on its own means just that space; libraries come in only when chosen
  const withLibraries = !options.space || Boolean(libraryIds || fileIds);

  const files: ScopeFile[] = !withLibraries ? [] : await LibraryFile.find({
    owner: userId,
    status: 'ready',
    material: { $ne: null },
    ...(fileIds ? { _id: { $in: fileIds } } : libraryIds ? { library: { $in: libraryIds } } : {}),
  })
    .sort({ createdAt: -1 })
    .lean<ILibraryFile[]>();

  const fromSpace = options.space ? await spaceFiles(userId, options.space) : null;
  const byMaterial = new Map<string, ScopeFile>();
  for (const file of [...(fromSpace?.files ?? []), ...files]) {
    const key = String(file.material);
    if (!byMaterial.has(key)) byMaterial.set(key, file);
  }

  const libraryFiles = files.map((file) => String(file.library));
  const [libraries, materials] = await Promise.all([
    Library.find({ _id: { $in: [...new Set(libraryFiles)] } }).select('name').lean(),
    Material.find({ _id: { $in: [...byMaterial.keys()] } }).select('status pageUnit').lean<IMaterial[]>(),
  ]);
  const libraryNames = new Map(libraries.map((library) => [String(library._id), library.name]));
  if (fromSpace?.name && fromSpace.files.length) libraryNames.set(fromSpace.name.id, fromSpace.name.name);

  return {
    byMaterial,
    libraryNames,
    materials: new Map(materials.map((material) => [String(material._id), material])),
  };
};

/** "4 files in 2 libraries", or "3 files in CSC 300L" for one space's course materials. */
export const describeScope = (scope: Scope) => {
  const files = scope.byMaterial.size;
  const count = `${files} file${files === 1 ? '' : 's'}`;
  const all = [...scope.byMaterial.values()];
  if (all.length && all.every((file) => file.spaceSlug)) {
    return `${count} in ${scope.libraryNames.get(String(all[0].library)) ?? 'this space'}`;
  }
  const libraries = scope.libraryNames.size;
  return `${count} in ${libraries} librar${libraries === 1 ? 'y' : 'ies'}`;
};

/** The files in a form `prepareAll` takes. */
export const toPrepare = (scope: Scope) =>
  [...scope.byMaterial.entries()].map(([material, file]) => ({
    material,
    name: file.name,
    status: scope.materials.get(material)?.status,
  }));

/** Whether each material counts pages, slides or sections, once it has been read. */
export const unitsOf = async (materialIds: string[]) =>
  new Map(
    (await Material.find({ _id: { $in: materialIds } }).select('pageUnit').lean<IMaterial[]>()).map((material) => [
      String(material._id),
      material.pageUnit,
    ])
  );

/**
 * Resolves the chosen files, reads any the AI hasn't read yet (streaming the
 * steps) and returns each ready material with the student's file for it.
 */
export const readySources = async (
  stream: Stream,
  userId: string,
  options: { libraryIds?: string[] | null; fileIds?: string[] | null; space?: SpaceScope | null }
): Promise<{ material: IMaterial; file: ScopeFile }[]> => {
  const scope = await resolveScope(userId, options);
  if (!scope.byMaterial.size) return [];
  const ready = await prepareAll(stream, userId, toPrepare(scope));
  const materials = await Material.find({ _id: { $in: [...ready] } });
  return materials.map((material) => ({ material, file: scope.byMaterial.get(String(material._id))! }));
};
