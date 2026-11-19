// `pnpm compose <args>`: runs `docker compose <args>` with the classic builder.
// Docker Compose v5 builds through Bake by default, and on Windows Bake stops every
// build with "additional privileges requested: --allow=fs.read=<Dockerfile>".
// COMPOSE_BAKE is only read from the process environment (not from .env), so this
// wrapper sets it. Already set in your shell? Your value wins.
import { spawn } from 'node:child_process';

const child = spawn('docker', ['compose', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, COMPOSE_BAKE: process.env.COMPOSE_BAKE ?? 'false' },
});
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
child.on('error', (err) => {
  console.error(`could not run docker compose: ${err.message}`);
  process.exit(1);
});
