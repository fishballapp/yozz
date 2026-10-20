// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { fakeRecordStore } from '../vault/fake-record-store';
import type { RecordStore } from '../vault/record-store';
import { forgetConsent, readConsents, rememberConsent } from './remote-images';
import { RemoteImagesStoreProvider, useRemoteImages } from './remote-images-context';

it('writes one consent change at a time, forgetting included, so a device never reads past its own write in flight', async () => {
  const { store } = fakeRecordStore();
  let inFlight = 0;
  let mostInFlight = 0;
  const slow: RecordStore = {
    ...store,
    put: async input => {
      inFlight += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      await store.put(input);
      inFlight -= 1;
    },
  };
  let remoteImages: ReturnType<typeof useRemoteImages> | undefined;
  const Probe = () => {
    remoteImages = useRemoteImages();
    return null;
  };
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <RemoteImagesStoreProvider store={slow}>
        <Probe />
      </RemoteImagesStoreProvider>,
    ),
  );
  await act(async () => {
    remoteImages?.consent({ messageId: 'mid/<1@x>', sender: 'a@x.example' });
    remoteImages?.consent({ messageId: 'mid/<2@x>', sender: 'a@x.example' });
    remoteImages?.consent({ messageId: 'mid/<3@x>', sender: 'a@x.example' });
    // Queued behind the three consents, so once the vault has it, so have they.
    await remoteImages?.unconsent({ messageId: 'mid/<3@x>', sender: 'a@x.example' });
  });
  expect(mostInFlight).toBe(1);
  expect((await readConsents(store)).consents.map(consent => consent.messageId)).toEqual([
    'mid/<1@x>',
    'mid/<2@x>',
  ]);
  await act(async () => root.unmount());
});

/** The provider over `store`, and a handle on what it offers. */
const mount = async (store: RecordStore) => {
  const handle: { current?: ReturnType<typeof useRemoteImages> } = {};
  const Probe = () => {
    handle.current = useRemoteImages();
    return null;
  };
  const root = createRoot(document.createElement('div'));
  await act(async () =>
    root.render(
      <RemoteImagesStoreProvider store={store}>
        <Probe />
      </RemoteImagesStoreProvider>,
    ),
  );
  const remoteImages = () => {
    if (handle.current === undefined) throw new Error('not mounted');
    return handle.current;
  };
  return { remoteImages, unmount: () => act(async () => root.unmount()) };
};

const settle = () => act(async () => new Promise(resolve => setTimeout(resolve, 20)));
const consentTo = (n: number) => ({ messageId: `mid/<${n}@x>`, sender: 'a@x.example' });
const unread = (): never => {
  throw new Error('the stored list was readable');
};

it("takes another device's removal from the vault's answer, not this tab's memory", async () => {
  const { store } = fakeRecordStore();
  await rememberConsent(store, consentTo(1), unread);
  const tab = await mount(store);
  await settle();
  expect(tab.remoteImages().isConsented(consentTo(1))).toBe(true);

  // The phone forgets message 1; this tab then loads message 2.
  await forgetConsent(store, consentTo(1), unread);
  await act(async () => tab.remoteImages().consent(consentTo(2)));
  await settle();
  expect(tab.remoteImages().isConsented(consentTo(1))).toBe(false);
  expect(tab.remoteImages().isConsented(consentTo(2))).toBe(true);
  await tab.unmount();
});

it('keeps a message stopped while its earlier consent is still on its way, and if the forget fails', async () => {
  const { store } = fakeRecordStore();
  const gate = Promise.withResolvers<void>();
  let puts = 0;
  const gated: RecordStore = {
    ...store,
    put: async input => {
      puts += 1;
      if (puts === 1) await gate.promise;
      // The forget behind it never reaches the vault.
      if (puts === 2) throw new TypeError('Failed to fetch');
      return store.put(input);
    },
  };
  const tab = await mount(gated);
  await settle();
  await act(async () => tab.remoteImages().consent(consentTo(1)));
  // Settled into a value at once, so the rejection is never left unhandled.
  const stopped = tab
    .remoteImages()
    .unconsent(consentTo(1))
    .then(
      () => 'stored',
      (error: unknown) => String(error),
    );
  await act(async () => gate.resolve());
  expect(await stopped).toBe('TypeError: Failed to fetch');
  await settle();
  expect(tab.remoteImages().isConsented(consentTo(1))).toBe(false);
  await tab.unmount();
});

it('remembers how a trust was given, and widens a verified-only one given again through the warning', async () => {
  const { store } = fakeRecordStore();
  const tab = await mount(store);
  await settle();
  await act(() => tab.remoteImages().trust({ address: 'News@x.example', isVerifiedOnly: true }));
  expect(tab.remoteImages().trustOf('news@x.example')?.isVerifiedOnly).toBe(true);

  await act(() => tab.remoteImages().trust({ address: 'news@x.example', isVerifiedOnly: false }));
  expect(tab.remoteImages().trustedSenders).toHaveLength(1);
  expect(tab.remoteImages().trustOf('NEWS@x.example')?.isVerifiedOnly).toBe(false);
  await tab.unmount();

  // Another session reads the widened record back from the vault.
  const next = await mount(store);
  await settle();
  expect(next.remoteImages().trustOf('news@x.example')?.isVerifiedOnly).toBe(false);
  await next.unmount();
});
