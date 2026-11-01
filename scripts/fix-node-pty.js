// node-pty's prebuilt spawn-helper ships without the execute bit on some installs,
// which makes every terminal fail with "posix_spawnp failed". Restore it.
const { chmodSync, existsSync, readdirSync } = require('node:fs')
const { join } = require('node:path')

const prebuilds = join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds')
if (existsSync(prebuilds)) {
  for (const dir of readdirSync(prebuilds)) {
    const helper = join(prebuilds, dir, 'spawn-helper')
    if (existsSync(helper)) chmodSync(helper, 0o755)
  }
}
