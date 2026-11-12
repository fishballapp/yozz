// Side-effect module, imported first by the entry so the swap lands before any module that uses
// Temporal is evaluated.
//
// `installImplementation` rather than `temporal-polyfill/global`, which defers to whatever the
// runtime already has. workerd ships a native Temporal whose `Temporal.Now` reads the UNIX epoch
// inside a Durable Object, so the global entry would be a no-op on prod and the tests would stop
// exercising the implementation prod runs. Nothing here reads `Temporal.Now`: the clock is
// `Date.now()`.
import { installImplementation } from 'temporal-polyfill/shim';

/** Whatever the runtime shipped before the swap, so a test can assert the swap won. */
export const nativeTemporal: unknown = globalThis.Temporal;

installImplementation();
