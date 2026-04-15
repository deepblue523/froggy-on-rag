/**
 * Text span used for lexical retrieval and for neural embeddings: chunk body
 * plus file/display name when present (body alone does not repeat the title).
 *
 * @param {{ content?: string | null, metadata?: { fileName?: string } | null } | null | undefined} chunk
 * @returns {string}
 */
function getChunkSearchText(chunk) {
  const body = chunk && chunk.content != null ? String(chunk.content) : '';
  const meta = chunk && chunk.metadata;
  if (meta && typeof meta.fileName === 'string' && meta.fileName.trim()) {
    const name = meta.fileName.trim();
    return body ? `${name}\n${body}` : name;
  }
  return body;
}

module.exports = { getChunkSearchText };
