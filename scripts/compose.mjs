// `pnpm compose <args>`: runs `docker compose <args>` with the classic builder.
// Docker Compose v5 builds through Bake by default, and on Windows Bake stops every
// build with "additional privileges requested: --allow=fs.read=<Dockerfile>".
// COMPOSE_BAKE is only read from the process environment (not from .env), so this
// wrapper sets it. It also caps parallel work at 2: building all six backend images
// at once ran Docker Desktop's VM (7.4 GiB) out of memory and BuildKit dropped the
// build ("rpc error: code = Unavailable ... EOF"). Already set in your shell? Your value wins.
import { spawn } from 'node:child_process';

const child = spawn('docker', ['compose', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    COMPOSE_BAKE: process.env.COMPOSE_BAKE ?? 'false',
    COMPOSE_PARALLEL_LIMIT: process.env.COMPOSE_PARALLEL_LIMIT ?? '2',
  },
});
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
child.on('error', (err) => {
  console.error(`could not run docker compose: ${err.message}`);
  process.exit(1);
});
