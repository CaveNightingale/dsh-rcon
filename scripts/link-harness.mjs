#!/usr/bin/env node
/**
 * Link this out-of-tree plugin's `node_modules` at a DeepSeek Harness checkout.
 *
 * The harness packages are not published, so a linked bundle resolves
 * `@deepseek-ai/*` from sibling sources. Symlinks (not copies) keep a single
 * module instance shared with the running harness, which is what the Loader's
 * resolution rules expect from a linked checkout.
 */
import { mkdir, rm, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')
const harnessRoot = resolve(process.env['DSH_HARNESS_ROOT'] ?? join(projectRoot, '..', 'deepseek-harness'))

if (!existsSync(join(harnessRoot, 'package.json'))) {
  console.error(`dsh-rcon: no DeepSeek Harness checkout at ${harnessRoot}`)
  console.error('Set DSH_HARNESS_ROOT to the harness root, then rerun.')
  process.exitCode = 1
} else {
  /** Harness packages this plugin imports, mapped to their checkout directories. */
  const harnessPackages = {
    '@deepseek-ai/cordis': 'vendor/cordis',
    '@deepseek-ai/schemastery': 'vendor/schemastery',
    '@deepseek-ai/dsh-agent': 'packages/core/agent',
    '@deepseek-ai/dsh-llm': 'packages/llm/llm',
    '@deepseek-ai/dsh-session': 'packages/core/session',
    '@deepseek-ai/dsh-tools': 'packages/core/tools',
  }
  /** Toolchain entries reused from the harness install instead of a download. */
  const sharedToolchain = {
    typescript: 'node_modules/typescript',
    '@types/node': 'node_modules/@types/node',
  }
  /** Binaries the package scripts invoke by bare name (`npm run` adds `.bin` to PATH). */
  const executables = {
    tsc: 'node_modules/typescript/bin/tsc',
    tsserver: 'node_modules/typescript/bin/tsserver',
  }
  const nodeModules = join(projectRoot, 'node_modules')
  let linked = 0
  for (const [name, relative] of Object.entries({ ...harnessPackages, ...sharedToolchain })) {
    const target = join(harnessRoot, relative)
    if (!existsSync(target)) {
      console.error(`dsh-rcon: ${name} is missing at ${target}; run "pnpm install" (and "pnpm build") in the harness first`)
      process.exitCode = 1
      continue
    }
    const linkPath = join(nodeModules, name)
    await mkdir(dirname(linkPath), { recursive: true })
    await rm(linkPath, { recursive: true, force: true })
    await symlink(target, linkPath, 'dir')
    linked += 1
  }
  for (const [name, relative] of Object.entries(executables)) {
    const target = join(harnessRoot, relative)
    if (!existsSync(target)) {
      console.error(`dsh-rcon: executable ${name} is missing at ${target}`)
      process.exitCode = 1
      continue
    }
    const linkPath = join(nodeModules, '.bin', name)
    await mkdir(dirname(linkPath), { recursive: true })
    await rm(linkPath, { force: true })
    await symlink(target, linkPath, 'file')
    linked += 1
  }
  if (process.exitCode !== 1) console.log(`dsh-rcon: linked ${String(linked)} entries into ${nodeModules}`)
}
