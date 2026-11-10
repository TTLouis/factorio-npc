import { libraryMetadata, readLibrary } from './method-library.mjs'

export const isCanonicalLibraryTool = name => ['findKnowledge', 'getKnowledgeDetails', 'findSkills', 'getSkillDetails'].includes(name)

// Tool names differ between hosts; query, ranking, full entries and authority do not.
export async function readCanonicalLibraryTool(name, args) {
  if (!isCanonicalLibraryTool(name)) throw new Error('unknown_library_tool')
  const search = name.startsWith('find')
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || Object.keys(args).some(field => !(search ? ['query', 'limit'] : ['id']).includes(field))) throw new Error('invalid_library_arguments')
  try {
    return JSON.stringify(await readLibrary({ ...args, kind: name.includes('Knowledge') ? 'knowledge' : 'skill',
      action: search ? 'search' : 'get' }))
  }
  catch (error) {
    // A missing id, including an id in the other namespace, is a bounded
    // advisory lookup refusal. It must neither abort gameplay nor load a skill.
    if (error?.code === 'library_entry_not_found') return JSON.stringify({ ok: false, error: 'library_entry_not_found' })
    throw error
  }
}

export function canonicalLibraryResult(raw) {
  let value
  try { value = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return undefined }
  return value?.authority?.content === 'untrusted_advisory' && value.authority.operation_authority === false
    && value.provenance?.source === libraryMetadata().source ? value : undefined
}
