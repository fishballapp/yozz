import { afterEach, describe, expect, it, vi } from 'vitest';
import { toast } from '../ui/Toast';
import { moveDoneTitle, reportMoved, wayBack } from './move-undo';

afterEach(() => vi.restoreAllMocks());

describe('moveDoneTitle', () => {
  it('names the move alone for one thread and after the count for several', () => {
    expect(moveDoneTitle('archive', 1)).toBe('Archived');
    expect(moveDoneTitle('trash', 1)).toBe('Moved to Trash');
    expect(moveDoneTitle('junk', 3)).toBe('3 moved to Junk');
    expect(moveDoneTitle('archive', 2)).toBe('2 archived');
  });
});

describe('wayBack', () => {
  it('brings back to the inbox what left it', () => {
    expect(wayBack(['inbox'], 'archive')).toEqual(['inbox']);
    expect(wayBack(['inbox', 'sent'], 'trash')).toEqual(['inbox']);
    expect(wayBack(['inbox'], 'junk')).toEqual(['inbox']);
  });

  it('goes through the inbox to put back what was deleted or junked out of Archive or Junk', () => {
    expect(wayBack(['archive'], 'trash')).toEqual(['inbox', 'archive']);
    expect(wayBack(['archive'], 'junk')).toEqual(['inbox', 'archive']);
    expect(wayBack(['junk'], 'trash')).toEqual(['inbox', 'junk']);
  });

  it('sends back where it came from what was moved to the inbox', () => {
    expect(wayBack(['trash'], 'inbox')).toEqual(['trash']);
    expect(wayBack(['archive'], 'inbox')).toEqual(['archive']);
    expect(wayBack(['junk'], 'inbox')).toEqual(['junk']);
  });
});

describe('reportMoved', () => {
  /** The toast raised, with its Undo pressed by `undo`. */
  const raised = () => {
    const add = vi.spyOn(toast, 'add').mockReturnValue('toast-1');
    vi.spyOn(toast, 'close').mockImplementation(() => {});
    return {
      add,
      undo: () => {
        const onClick = add.mock.calls[0]?.[0].actionProps?.onClick;
        if (onClick === undefined) throw new Error('No Undo on the toast');
        onClick({} as never);
      },
    };
  };

  it('says nothing when the move took no thread', () => {
    const { add } = raised();
    reportMoved([], 'archive', vi.fn());
    expect(add).not.toHaveBeenCalled();
  });

  it('offers Undo, which moves each thread back the way it came, one write per way', () => {
    const { add, undo } = raised();
    const move = vi.fn();
    reportMoved(
      [
        { id: 'a', subject: 'Invoice', folders: ['inbox'] },
        { id: 'b', subject: 'Receipt', folders: ['archive'] },
        { id: 'c', subject: 'Lunch', folders: ['inbox'] },
      ],
      'trash',
      move,
    );
    expect(add.mock.calls[0]?.[0]).toMatchObject({ title: '3 moved to Trash', timeout: 10_000 });
    expect(move).not.toHaveBeenCalled();

    undo();
    expect(move.mock.calls.map(([ids, to]) => [ids, to])).toEqual([
      [['a', 'c'], 'inbox'],
      [['b'], 'inbox'],
      [['b'], 'archive'],
    ]);
  });

  it('names the subject of one thread, which the screen has already moved on from, and only that', () => {
    const { add } = raised();
    reportMoved(
      [{ id: 'a', subject: 'Deploy failed on main', folders: ['inbox'] }],
      'archive',
      vi.fn(),
    );
    reportMoved(
      [
        { id: 'a', subject: 'Deploy failed on main', folders: ['inbox'] },
        { id: 'b', subject: 'Receipt', folders: ['inbox'] },
      ],
      'archive',
      vi.fn(),
    );
    expect(add.mock.calls[0]?.[0]).toMatchObject({
      title: 'Archived',
      data: { detail: 'Deploy failed on main' },
    });
    expect(add.mock.calls[1]?.[0]).toMatchObject({ title: '2 archived' });
    expect(add.mock.calls[1]?.[0]).not.toHaveProperty('data');
  });

  it('says once that the undo was refused, and why', () => {
    const { add, undo } = raised();
    reportMoved(
      [{ id: 'b', subject: 'Receipt', folders: ['archive'] }],
      'trash',
      (_ids, _to, onRefused) => onRefused('The server said no.'),
    );
    undo();
    expect(add.mock.calls.slice(1).map(([options]) => options)).toEqual([
      { title: 'Not undone', description: 'The server said no.', timeout: 0, priority: 'high' },
    ]);
  });
});
