#!/usr/bin/env node
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import * as Stdio from 'effect/Stdio';
import packageJson from '../package.json' with { type: 'json' };
import { CliLayer, cli } from './app.ts';
import { MailServers } from './mail/servers.ts';
import { runCommand } from './output.ts';

Stdio.Stdio.use(({ args }) =>
  Effect.flatMap(args, runCommand(cli, { version: packageJson.version })),
).pipe(
  Effect.provide(
    Layer.mergeAll(FetchHttpClient.layer, MailServers.layerTls, CliLayer).pipe(
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
  NodeRuntime.runMain,
);
