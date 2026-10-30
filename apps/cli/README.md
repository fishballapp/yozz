# yozz

The mail in your [YOZZ](https://yozz.app) account, from a terminal: for coding agents (Claude Code,
Codex and the like) and the person beside them.

YOZZ's servers hold only ciphertext, so `yozz` is a real mail client, not a client of an API. It
opens your vault on this machine with a key you approve from yozz.app, reads your addresses from it,
and (soon) speaks IMAP and SMTP to your own mail servers itself.

**Status:** `login`, `logout` and `whoami` work. `list`, `read`, `update`, `draft`, `send` and
`discard` are in the help with their flags, and answer `UsageError` until they are built. Not on npm
yet.

## Run it

From a checkout of this repository (Node 26 or later):

```sh
pnpm install
pnpm -F @yozz.app/cli build
node apps/cli/dist/bin.js --help
```

## Log in

```sh
yozz login [--name <name>]
```

`login` prints a pairing code and a URL on stderr and opens the URL in your browser. Sign in to
yozz.app there if you need to, check that the page shows the same code as the terminal, and
approve. The code matters: a link someone else made carries their key, and the code is how you
tell yours apart.

The key is written to `$XDG_CONFIG_HOME/yozz/credentials.json` (`~/.config/yozz/…` by default),
readable by you only. `--name` is what yozz.app's Settings → Sign-in calls it; it defaults to this
machine's hostname. Settings lists every CLI key with its code and when it was last used, and
revokes any of them. Logging in again revokes the key the credentials file held before; if that
fails, `login` says so on stderr and you can revoke it in Settings.

For CI or a sandbox, put the whole credentials file in `YOZZ_CLI_KEY` instead: it wins over the
file. A key copied off the disk opens the vault until it is revoked, as an unlocked laptop would.

```sh
yozz whoami     # the account, this key, and every address
yozz logout     # revoke this key, delete its credentials, revision marks and cache
```

## The output contract

- Success is one JSON document on stdout, exit 0.
- Failure is one line on stderr, `{"error":{"code":"…","message":"…"}}`, exit 1. Match on `code`:
  `UsageError`, `NotLoggedIn`, `KeyRevoked`, `NetworkError`, `ApiError` (with the API's `status`),
  `VaultUnreadable`, `LoginDenied`, `LoginTimedOut`, `LoginFailed`. A mistyped command or flag is a
  `UsageError` line too, with nothing on stdout.
- Nothing ever prompts. Progress (login's pairing code and URL) goes to stderr.
- `yozz --help` opens with how to drive it; each command's `--help` shows its output and an example.

## Settings

| Variable | Default | |
| --- | --- | --- |
| `YOZZ_CLI_KEY` | | The credentials file's contents; wins over the file |
| `YOZZ_API_URL` | the key's own API, else `https://api.yozz.app` | `login` makes its key here, or on `https://api.yozz.app` |
| `YOZZ_WEB_URL` | `https://yozz.app` | Where `login` sends the browser |
| `XDG_CONFIG_HOME` | `~/.config` | `yozz/credentials.json` |
| `XDG_STATE_HOME` | `~/.local/state` | `yozz/<userId>/revision-marks.json`: the newest revision seen of each record, so the server cannot replay an older one |
| `XDG_CACHE_HOME` | `~/.cache` | `yozz/<userId>/`: the mail cache |

## Licence

AGPL-3.0-only, as the rest of YOZZ.
