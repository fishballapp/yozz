import { defaultParseSearch } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';
import { enrolSearch } from './enrol';

/** The query the way the router reads it, so a value's JSON type is the one the page sees. */
const readSearch = (url: string) => enrolSearch.parse(defaultParseSearch(new URL(url).search));

describe('/enrol search', () => {
  it('reads the recovery link as a reset', () => {
    expect(readSearch('https://yozz.app/enrol?reset=true')).toEqual({ reset: true });
  });

  it('reads the signup link as no reset', () => {
    expect(readSearch('https://yozz.app/enrol')).toEqual({});
  });
});
