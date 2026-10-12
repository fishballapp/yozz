import { useState } from 'react';

/**
 * Which rows of the list are ticked, as Gmail does it: a box per row, Shift-click for a range, and
 * one box over them all that ticks everything or, once anything is ticked, clears it.
 *
 * A selection belongs to one `scope` (mailbox, search and open message): change any of them and it
 * is gone, so opening a message clears it without anything having to say so. Below `lg`, where a
 * row has no box until you ask, `isSelecting` is the Select button's mode, and unticking the last
 * row leaves it.
 */
export type Selection = {
  readonly ids: ReadonlySet<string>;
  /** The last row clicked, where a Shift-click's range starts. */
  readonly anchor: string | null;
  readonly isSelecting: boolean;
};

export const NO_SELECTION: Selection = { ids: new Set(), anchor: null, isSelecting: false };

/** Ticks or unticks one row, or with `extend` every row from the anchor to it. */
export const check = (
  selection: Selection,
  order: readonly string[],
  id: string,
  isChecked: boolean,
  extend: boolean,
): Selection => {
  const from = extend && selection.anchor !== null ? order.indexOf(selection.anchor) : -1;
  const to = order.indexOf(id);
  const span =
    from === -1 || to === -1 ? [id] : order.slice(Math.min(from, to), Math.max(from, to) + 1);
  // Only rows still in the list: one a sync took away must not keep the selection alive.
  const ids = new Set(order.filter(candidate => selection.ids.has(candidate)));
  for (const candidate of span) {
    if (isChecked) {
      ids.add(candidate);
    } else {
      ids.delete(candidate);
    }
  }
  return { ids, anchor: id, isSelecting: ids.size > 0 && selection.isSelecting };
};

/** The box over the list: everything when nothing is ticked, nothing otherwise. */
export const toggleAll = (selection: Selection, order: readonly string[]): Selection =>
  order.some(id => selection.ids.has(id))
    ? NO_SELECTION
    : { ids: new Set(order), anchor: null, isSelecting: selection.isSelecting };

export const useSelection = (order: readonly string[], scope: string) => {
  const [state, setState] = useState({ scope, selection: NO_SELECTION });
  // Dropped, not only hidden, when the scope moves on: closing a message must not bring back the
  // ticks from before it was opened.
  if (state.scope !== scope) setState({ scope, selection: NO_SELECTION });
  const selection = state.scope === scope ? state.selection : NO_SELECTION;
  const update = (next: (current: Selection) => Selection) =>
    setState(previous => ({
      scope,
      selection: next(previous.scope === scope ? previous.selection : NO_SELECTION),
    }));
  const checkedIds = order.filter(id => selection.ids.has(id));

  return {
    checkedIds,
    isChecked: (id: string) => selection.ids.has(id),
    isAllChecked: checkedIds.length > 0 && checkedIds.length === order.length,
    isSelecting: selection.isSelecting || checkedIds.length > 0,
    check: (id: string, isChecked: boolean, extend: boolean) =>
      update(current => check(current, order, id, isChecked, extend)),
    toggleAll: () => update(current => toggleAll(current, order)),
    /** The Select button: in with nothing ticked, or out again. */
    setSelecting: (isSelecting: boolean) => update(() => ({ ...NO_SELECTION, isSelecting })),
    clear: () => update(() => NO_SELECTION),
  };
};
