// Packet and continuation formatting shared without importing the packet builder or topology.
import { sanitizeDurableModelText } from './durable-text.mjs'
import { MAX_REVIEW_NOTES_CHARS } from './planning-state.mjs'

export const HANDOFF_PACKET_MAX_CHARS = 6000
export const HANDOFF_NOTE_CHARS = 500
export const PLANNER_REVIEW_NOTES_LABEL = "planner_review_notes (the planner's reply to your review of this step; the plan is unchanged; advisory, not world evidence): "

export const isHandoffPacketRow = row => row?.role === 'user' && typeof row.content === 'string'
  && (row.content.startsWith('[HANDOFF]') || row.content.startsWith('--- step block ---'))

// Each split packet row includes its trailing separator, matching provider-time fitting.
export function handoffPacketChars(messages) {
  return messages.filter(isHandoffPacketRow).reduce((sum, row) => sum + row.content.length + 1, 0)
}

// Preserve the packet's control-character/one-line normalization before durable identity sanitation.
export function sanitizeHandoffNote(value, max = HANDOFF_NOTE_CHARS) {
  const input = String(value ?? '')
  const flat = input.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim()
  const normalizationMax = Math.max(2000, input.length)
  const normalized = flat.length <= normalizationMax ? flat : `${flat.slice(0, Math.max(0, normalizationMax - 1))}…`
  return sanitizeDurableModelText(normalized, max)
}

export function plannerReviewNotesRecord(value, max = MAX_REVIEW_NOTES_CHARS) {
  const notes = sanitizeHandoffNote(value, max)
  return notes ? { key: 'review_notes', block: 'step', drop: 'review_notes', text: `${PLANNER_REVIEW_NOTES_LABEL}${notes}` } : undefined
}
