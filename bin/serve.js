#!/usr/bin/env node
// 启动 GUI：node bin/serve.js [--port 8787]

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { startServer } from '../src/server/app.js';

const ROOT = process.cwd();
const configPath = path.join(ROOT, 'config.json');
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const port = portArg >= 0 ? Number(args[portArg + 1]) : Number(process.env.PORT || 8787);
const hostArg = args.indexOf('--host');
const host = hostArg >= 0 ? args[hostArg + 1] : '127.0.0.1';

startServer({ root: path.join(ROOT, config.dataDir || 'data'), config, port, host });
