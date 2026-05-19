#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { homedir } = require('node:os');

const rootDir = join(__dirname, '..');

const env = {
  ...process.env,
  DB_PATH: process.env.DB_PATH ?? join(homedir(), '.iclaw', 'data', 'iclaw.db'),
};

const child = spawn(process.execPath, [join(rootDir, 'dist', 'index.js')], {
  stdio: 'inherit',
  cwd: rootDir,
  env,
});

child.on('exit', (code) => process.exit(code ?? 0));
