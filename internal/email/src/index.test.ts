import { afterEach, describe, expect, it, vi } from 'vitest';
import { createForwardEmailClient } from './index';

const client = createForwardEmailClient({ alias: 'no-reply@example.app', password: 'pw' });

const okFetch = () => vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createForwardEmailClient', () => {
  it('POSTs the provider wire shape with Basic auth from the alias', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);

    await client.send({ to: 'driver@example.com', subject: 'hi', text: 'body' });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.forwardemail.net/v1/emails');
    expect(init.headers.Authorization).toBe(`Basic ${btoa('no-reply@example.app:pw')}`);
    expect(JSON.parse(init.body)).toEqual({
      from: 'no-reply@example.app',
      to: 'driver@example.com',
      subject: 'hi',
      text: 'body',
    });
  });

  it('honours a display-name from and joins multiple recipients', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);

    await client.send({
      from: 'Acme <no-reply@example.app>',
      to: ['a@example.com', 'b@example.com'],
      subject: 'hi',
      html: '<p>body</p>',
    });

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toEqual({
      from: 'Acme <no-reply@example.app>',
      to: 'a@example.com, b@example.com',
      subject: 'hi',
      html: '<p>body</p>',
    });
  });

  it('rejects a body-less send before hitting the network', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);

    await expect(client.send({ to: 'a@example.com', subject: 'hi' })).rejects.toThrow(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws with status + body on a provider error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('quota', { status: 429 })));

    await expect(client.send({ to: 'a@example.com', subject: 'hi', text: 'x' })).rejects.toThrow(
      'forwardemail send failed: 429 quota',
    );
  });
});
