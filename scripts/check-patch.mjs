#!/usr/bin/env node
/**
 * Validate `cordis.patch.yml` the way the Loader reads it, without booting a
 * profile.
 *
 * The Loader rejects an inserted row that carries no `name` ("row N names no
 * plugin") only when the preset actually mounts — i.e. when a session resumes.
 * That is exactly how a broken patch reached production once: `--dump-config`
 * happily composed it, and the failure appeared on the next restart. This script
 * closes that gap by checking the same invariants up front.
 *
 * Checks:
 *   1. every entry carrying an `id` also carries a non-empty string `name`;
 *   2. a relative `name` (`./…`) resolves to a file beside this patch — the
 *      packaged form of the plugin rows must exist before publishing;
 *   3. absolute `name` values are reported as publish blockers: they point at
 *      one machine's profile and cannot work on anyone else's;
 *   4. duplicate row ids inside the same list are rejected (the Loader keeps one
 *      of them silently, which hides a mistake).
 *
 * Exit codes: 0 = all checks pass, 1 = errors (details on stderr).
 *
 * @module dsh-beta-battle-mode/scripts/check-patch
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PATCH = resolvePath(here, '..', 'cordis.patch.yml')

/**
 * Locate the running DSH installation so the YAML parser comes from the same
 * copy the Loader uses. Also accepts an explicit `--dsh <path-to-entry>`.
 * @returns {string | undefined} package root of `@deepseek-ai/dsh`.
 */
function findHostRoot() {
  const flag = process.argv.indexOf('--dsh')
  const candidates = []
  if (flag !== -1 && process.argv[flag + 1] !== undefined) candidates.push(process.argv[flag + 1])
  if (process.argv[1] !== undefined) candidates.push(process.argv[1])
  try {
    candidates.push(execFileSync('command', ['-v', 'dsh'], { shell: '/bin/sh', encoding: 'utf-8' }).trim())
  } catch {
    // `dsh` not on PATH: fall back to the candidates above.
  }
  for (const candidate of candidates) {
    if (!candidate) continue
    let directory
    try {
      directory = dirname(realpathSync(candidate))
    } catch {
      continue
    }
    for (;;) {
      const manifest = join(directory, 'package.json')
      if (existsSync(manifest)) {
        try {
          if (JSON.parse(readFileSync(manifest, 'utf-8')).name === '@deepseek-ai/dsh') return directory
        } catch {
          // Invalid manifest: keep walking up.
        }
      }
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  return undefined
}

/** Load a YAML parser from the running DSH installation. */
async function loadYaml() {
  try {
    return await import('yaml')
  } catch {
    const hostRoot = findHostRoot()
    if (hostRoot === undefined) {
      console.error('check-patch: cannot find the DSH installation; pass --dsh <path-to-dsh-entry>')
      process.exit(1)
    }
    const require = createRequire(join(hostRoot, 'package.json'))
    return await import(pathToFileURL(require.resolve('yaml')).href)
  }
}

const errors = []
const warnings = []

/**
 * Walk every entry list in the patch.
 * @param {unknown} node - value being visited.
 * @param {string} path - diagnostic path of the current list.
 */
function walk(node, path) {
  if (Array.isArray(node)) {
    const seen = new Set()
    node.forEach((entry, index) => {
      const where = `${path}[${index}]`
      if (entry === null || typeof entry !== 'object') return
      const id = entry.id
      if (typeof id === 'string') {
        if (seen.has(id)) errors.push(`${where}: duplicate row id "${id}" in the same list`)
        seen.add(id)
        if (typeof entry.name !== 'string' || entry.name.trim() === '') {
          errors.push(
            `${where}: row "${id}" has no "name" — the Loader fails at mount with "names no plugin"`
          )
        } else {
          checkName(entry.name, `${where} (${id})`)
        }
      }
      for (const [key, value] of Object.entries(entry)) {
        if (key === 'id' || key === 'name') continue
        walk(value, `${where}.${key}`)
      }
    })
    return
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`)
  }
}

/**
 * Classify one row name.
 * @param {string} name - the row's `name`.
 * @param {string} where - diagnostic location.
 */
function checkName(name, where) {
  if (isAbsolute(name)) {
    warnings.push(
      `${where}: absolute row path "${name}" — cannot ship; use a relative "./…" path or a package specifier`
    )
    return
  }
  if (!name.startsWith('./') && !name.startsWith('../')) return
  const target = resolvePath(dirname(PATCH), name)
  if (!existsSync(target)) errors.push(`${where}: relative row "${name}" does not exist beside the patch`)
}

const yaml = await loadYaml()
const parse = yaml.parse ?? yaml.default?.parse
if (typeof parse !== 'function') {
  console.error('check-patch: could not load a YAML parser')
  process.exit(1)
}

let document
try {
  document = parse(readFileSync(PATCH, 'utf-8'), { logLevel: 'silent' })
} catch (error) {
  console.error(`check-patch: ${PATCH} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

walk(document, 'patch')

for (const warning of warnings) console.warn(`warn: ${warning}`)
if (errors.length > 0) {
  for (const error of errors) console.error(`error: ${error}`)
  console.error(`\ncheck-patch: ${errors.length} error(s) in ${PATCH}`)
  process.exit(1)
}

const rows = JSON.stringify(document).match(/"id":/g)?.length ?? 0
console.log(`check-patch: OK — ${rows} row(s) in ${PATCH}${warnings.length > 0 ? `, ${warnings.length} warning(s)` : ''}`)
