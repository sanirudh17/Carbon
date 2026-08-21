// Shared collection utilities (color derivation, used by EnlargedWindow + QuickOverlay)

export const COLLECTION_COLORS = [
  '#6366F1', // Indigo
  '#3B82F6', // Blue
  '#0EA5E9', // Sky
  '#06B6D4', // Cyan
  '#14B8A6', // Teal
  '#10B981', // Emerald
  '#22C55E', // Green
  '#84CC16', // Lime
  '#EAB308', // Yellow
  '#F59E0B', // Amber
  '#F97316', // Orange
  '#EF4444', // Red
  '#F43F5E', // Rose
  '#EC4899', // Pink
  '#D946EF', // Fuchsia
  '#A855F7', // Purple
  '#8B5CF6', // Violet
  '#7C3AED', // Deep Violet
  '#4F46E5', // Deep Indigo
  '#2563EB', // Royal Blue
  '#0284C7', // Ocean
  '#059669', // Dark Emerald
  '#D97706', // Ochre
  '#E11D48', // Crimson
];

// Stable hue derived from the collection name so each collection
// gets a distinct, varied identity across sessions with great distribution.
export function collectionColorFor(name: string): string {
  const trimmed = (name || '').trim().toLowerCase();
  if (!trimmed) return COLLECTION_COLORS[0];
  let h = 2166136261;
  for (let i = 0; i < trimmed.length; i++) {
    h ^= trimmed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const index = Math.abs(h >>> 0) % COLLECTION_COLORS.length;
  return COLLECTION_COLORS[index];
}
