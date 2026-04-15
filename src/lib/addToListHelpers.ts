/**
 * Pure helpers that power AddToListDropdown. Extracted so the state
 * transitions are easy to unit-test without a DOM environment.
 */

export interface ListStatus {
  listId: string
  listName: string
  filmCount: number
  containsFilm: boolean
}

/**
 * Toggle the containsFilm flag for a single list. Adjusts filmCount
 * optimistically so the UI updates instantly. Returns the next array
 * and whether the film was previously in the list so the caller knows
 * which HTTP verb to use.
 */
export function toggleListStatus(
  lists: ListStatus[],
  listId: string
): { next: ListStatus[]; wasIn: boolean } {
  const target = lists.find((l) => l.listId === listId)
  const wasIn = target?.containsFilm ?? false
  const next = lists.map((l) =>
    l.listId === listId
      ? {
          ...l,
          containsFilm: !wasIn,
          filmCount: Math.max(0, l.filmCount + (wasIn ? -1 : 1)),
        }
      : l
  )
  return { next, wasIn }
}

/**
 * Prepend a freshly created list (with the current film already in it)
 * to the existing list array. Duplicate ids are guarded against in case
 * the caller re-fires the create flow.
 */
export function prependCreatedList(
  lists: ListStatus[],
  created: { id: string; name: string }
): ListStatus[] {
  if (lists.some((l) => l.listId === created.id)) return lists
  return [
    { listId: created.id, listName: created.name, filmCount: 1, containsFilm: true },
    ...lists,
  ]
}

/**
 * True when a document-level event (mousedown, click) should collapse
 * the dropdown because it originated outside the container. Extracted
 * so the "closes on outside click" behavior is testable without a DOM
 * — tests pass plain objects with a `contains` method as stand-ins.
 */
export interface ContainsLike<T> {
  contains(node: T): boolean
}

export function shouldCloseOnOutsideEvent<T>(
  container: ContainsLike<T> | null,
  target: T
): boolean {
  if (!container) return false
  return !container.contains(target)
}
