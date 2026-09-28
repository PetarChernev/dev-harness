#!/usr/bin/env node
import { Command } from 'commander';

const cli = new Command().name('harness').description('Local-first trusted-local development harness').version('0.1.0');
cli.command('doctor').description('Inspect generic runtime prerequisites (no model calls)').requiredOption('--repo <path>', 'target repository').action((opts: { repo: string }) => {
  console.log(JSON.stringify({ node: process.version, repo: opts.repo, mode: 'trusted-local', live: 'unverified' }));
});
await cli.parseAsync();
