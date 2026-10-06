function sourceId(index) { return `source-${index + 1}`; }

/** Builds the authoritative source identity catalog for one edit job. */
export function createSourceCatalog(sources = [], media = []) {
  const mediaByIndex = new Map(media.map((entry, index) => [index, entry]));
  return [...sources]
    .sort((left, right) => left.index - right.index)
    .map((source) => {
      const metadata = mediaByIndex.get(source.index);
      if (!metadata) throw new Error(`Missing media metadata for source ${source.index + 1}`);
      return {
        sourceId: sourceId(source.index),
        index: source.index,
        ordinal: source.index + 1,
        filename: source.name,
        duration: metadata.duration,
        width: metadata.width,
        height: metadata.height,
        hasAudio: metadata.hasAudio
      };
    });
}
