/**
 * git-service.ts — Auto version control for agent actions.
 *
 * System Git preferred; dugite bundled-binary as fallback.
 * Commits only files the agent changed (pre/post snapshot diff).
 */
import { execFile, execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'

// ── Default .gitignore for new repos ────────────────────────────────────────

const DEFAULT_GITIGNORE = `# Dependencies
node_modules/

# Environment
.env
.env.*
.env.local

# OS files
.DS_Store
Thumbs.db

# Logs
*.log
npm-debug.log*

# Build output
dist/
build/
out/
`

// ── Git binary resolution ───────────────────────────────────────────────────

let cachedGitPath: string | null = null

/**
 * Resolve the Git binary path.
 * Tries system Git first, falls back to dugite's bundled binary.
 * Result is cached for the lifetime of the process.
 */
export function resolveGitBinary(): string {
  if (cachedGitPath) return cachedGitPath

  // 1. Try system Git
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which'
    const result = execFileSync(cmd, ['git'], {
      timeout: 5_000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const gitPath = result.trim().split('\n')[0].trim()
    if (gitPath) {
      cachedGitPath = gitPath
      return cachedGitPath
    }
  } catch {
    // System Git not found — try dugite
  }

  // 2. Dugite fallback (bundled Git binary)
  try {
    // Dynamic require — dugite may not be installed in dev
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const dugite = require('dugite')
    const binaryPath: string | undefined = dugite.GitProcess?.gitBinaryPath
    if (binaryPath) {
      cachedGitPath = binaryPath
      return cachedGitPath
    }
  } catch {
    // dugite not available
  }

  throw new Error('Git binary not found — install Git or include dugite')
}

/**
 * Check whether Git is available at all (system or dugite).
 */
export function isGitAvailable(): boolean {
  try {
    resolveGitBinary()
    return true
  } catch {
    return false
  }
}

// ── Git command execution ───────────────────────────────────────────────────

/**
 * Execute a git command in the given working directory.
 * Returns stdout on success, throws on failure.
 */
function gitExec(args: string[], cwd: string): Promise<string> {
  const gitPath = resolveGitBinary()
  return new Promise((resolve, reject) => {
    execFile(
      gitPath,
      args,
      {
        cwd,
        timeout: 30_000,
        encoding: 'utf-8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr?.trim() || err.message))
        else resolve(stdout)
      },
    )
  })
}

// ── Repository helpers ──────────────────────────────────────────────────────

/**
 * Check if the folder is inside a Git working tree.
 */
export async function isGitRepo(folderPath: string): Promise<boolean> {
  try {
    const result = await gitExec(['rev-parse', '--is-inside-work-tree'], folderPath)
    return result.trim() === 'true'
  } catch {
    return false
  }
}

/**
 * Ensure the folder is a Git repository.
 * If .git exists → do nothing. Otherwise → `git init`.
 */
export async function ensureRepo(folderPath: string): Promise<void> {
  if (await isGitRepo(folderPath)) return

  await gitExec(['init'], folderPath)
  // Default branch name = main
  try {
    await gitExec(['checkout', '-b', 'main'], folderPath)
  } catch {
    // May fail if 'main' already exists or git version < 2.28
  }
}

/**
 * Create a default .gitignore if one doesn't exist yet.
 * Never touches an existing .gitignore.
 */
export function ensureGitignore(folderPath: string): void {
  const gitignorePath = path.join(folderPath, '.gitignore')
  if (fs.existsSync(gitignorePath)) return
  fs.writeFileSync(gitignorePath, DEFAULT_GITIGNORE, 'utf-8')
}

// ── Branch management (Phase 2) ────────────────────────────────────────────

/**
 * Get the current branch name.
 * Returns 'HEAD' if in detached HEAD state.
 */
export async function getCurrentBranch(folderPath: string): Promise<string> {
  const branch = await gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], folderPath)
  return branch.trim()
}

/**
 * Check whether the repo has at least one commit.
 * Branching requires at least one commit to exist.
 */
async function hasCommits(folderPath: string): Promise<boolean> {
  try {
    await gitExec(['rev-parse', 'HEAD'], folderPath)
    return true
  } catch {
    return false
  }
}

/**
 * Create (or reset) an agent-specific branch and check it out.
 *
 * - Branches from the current branch (AC-9: respects user's active branch)
 * - Uses `checkout -B` to force-create or reset the branch at current HEAD
 * - If the repo has no commits yet, branching is impossible — skips silently
 *
 * @returns baseBranch (the branch to merge back into) and whether the branch was created
 */
export async function createAgentBranch(
  folderPath: string,
  agentName: string,
): Promise<{ baseBranch: string; agentBranch: string; created: boolean; error?: string }> {
  try {
    await ensureRepo(folderPath)
    ensureGitignore(folderPath)

    // Can't branch from an empty repo (no commits)
    if (!(await hasCommits(folderPath))) {
      return { baseBranch: 'main', agentBranch: 'main', created: false }
    }

    const baseBranch = await getCurrentBranch(folderPath)
    const agentBranch = `agent/${agentName}`

    // Create or reset agent branch at current HEAD and switch to it
    await gitExec(['checkout', '-B', agentBranch], folderPath)

    return { baseBranch, agentBranch, created: true }
  } catch (e: any) {
    // If anything fails, stay on current branch — Phase 1 fallback
    return { baseBranch: 'main', agentBranch: 'main', created: false, error: e.message }
  }
}

/**
 * Merge the agent branch back into the base branch using fast-forward only.
 *
 * - Checks out the base branch first
 * - Attempts `--ff-only` merge (no merge commits)
 * - On conflict: aborts merge, returns conflict=true, agent branch preserved
 * - On success: returns merged=true
 */
export async function mergeAgentBranch(
  folderPath: string,
  agentName: string,
  baseBranch: string,
): Promise<{ merged: boolean; conflict: boolean; agentBranch: string; error?: string }> {
  const agentBranch = `agent/${agentName}`
  try {
    // Switch back to base branch
    await gitExec(['checkout', baseBranch], folderPath)

    // Attempt fast-forward merge
    try {
      await gitExec(['merge', agentBranch, '--ff-only'], folderPath)
      return { merged: true, conflict: false, agentBranch }
    } catch {
      // FF not possible — the base branch moved forward while agent was working
      try {
        await gitExec(['merge', '--abort'], folderPath)
      } catch {
        // merge --abort may fail if there was no merge in progress
      }
      return { merged: false, conflict: true, agentBranch }
    }
  } catch (e: any) {
    // Checkout to base failed — try to recover
    try {
      await gitExec(['checkout', baseBranch], folderPath)
    } catch {
      // Last resort: leave on whatever branch we're on
    }
    return { merged: false, conflict: false, agentBranch, error: e.message }
  }
}

/**
 * Delete the agent branch after a successful merge.
 * Uses -d (safe delete) — Git will refuse if the branch isn't fully merged.
 */
export async function cleanupAgentBranch(
  folderPath: string,
  agentName: string,
): Promise<void> {
  try {
    const agentBranch = `agent/${agentName}`
    await gitExec(['branch', '-d', agentBranch], folderPath)
  } catch {
    // Branch may already be deleted or not fully merged — that's fine
  }
}

// ── Snapshot-based change tracking ──────────────────────────────────────────

/**
 * Take a snapshot of the current `git status --porcelain` output.
 * Used before agent execution to later diff against post-execution status.
 * Returns a Set of raw status lines (e.g. " M src/main.ts").
 */
export async function takeSnapshot(folderPath: string): Promise<Set<string>> {
  try {
    if (!(await isGitRepo(folderPath))) return new Set()
    const output = await gitExec(['status', '--porcelain'], folderPath)
    return new Set(output.split('\n').filter(Boolean))
  } catch {
    return new Set()
  }
}

// ── Auto-commit ─────────────────────────────────────────────────────────────

/**
 * Extract a short summary from an agent's response for the commit message.
 * Takes the first meaningful line, stripped of markdown formatting.
 */
export function extractCommitSummary(text: string): string {
  if (!text || text === '[interrupted]') return 'Auto-save'

  // Strip markdown formatting
  const clean = text
    .replace(/^#+\s*/gm, '')       // headings
    .replace(/\*\*/g, '')          // bold
    .replace(/`{1,3}[^`]*`{1,3}/g, '') // inline code
    .trim()

  // Take first non-empty line
  const lines = clean.split('\n').filter((l) => l.trim().length > 0)
  if (lines.length === 0) return 'Auto-save'

  const first = lines[0].trim()
  // Take first sentence (split on . ! ? followed by space)
  const sentence = first.split(/[.!?]\s/)[0]
  return sentence.slice(0, 72) || 'Auto-save'
}

/**
 * Auto-commit files that changed since the given snapshot.
 *
 * Key safety rule: only stages files that are NEW or CHANGED compared
 * to the pre-snapshot. Pre-existing uncommitted changes are untouched.
 *
 * @param folderPath  Project folder
 * @param agentName   Agent name (used as commit author)
 * @param summary     Short description for commit message
 * @param preSnapshot Snapshot taken before agent execution
 * @returns           Result with committed flag and optional file list / error
 */
export async function autoCommit(
  folderPath: string,
  agentName: string,
  summary: string,
  preSnapshot: Set<string>,
): Promise<{ committed: boolean; files?: string[]; error?: string }> {
  try {
    // Ensure repo + gitignore (lazy init for new projects)
    await ensureRepo(folderPath)
    ensureGitignore(folderPath)


    // Get current status
    const postOutput = await gitExec(['status', '--porcelain'], folderPath)
    const postLines = postOutput.split('\n').filter(Boolean)

    // Diff: only lines that weren't in the pre-snapshot
    const newChanges = postLines.filter((line) => !preSnapshot.has(line))
    if (newChanges.length === 0) return { committed: false }

    // Extract file paths from porcelain status lines
    // Format: "XY filename" or "XY old -> new" (renames)
    const filePaths = newChanges.map((line) => {
      const raw = line.slice(3) // Skip "XY " status prefix
      const arrowIdx = raw.indexOf(' -> ')
      return arrowIdx >= 0 ? raw.slice(arrowIdx + 4) : raw
    })

    // Stage only the agent-changed files
    for (const fp of filePaths) {
      try {
        await gitExec(['add', '--', fp], folderPath)
      } catch {
        // Skip files that can't be added (gitignored, deleted, etc.)
      }
    }

    // Verify something is actually staged
    const stagedOutput = await gitExec(['diff', '--cached', '--name-only'], folderPath)
    const stagedFiles = stagedOutput.trim().split('\n').filter(Boolean)
    if (stagedFiles.length === 0) return { committed: false }

    // Build commit message
    const fileList = stagedFiles.slice(0, 20).map((f) => `- ${f}`).join('\n')
    const overflow =
      stagedFiles.length > 20
        ? `\n... and ${stagedFiles.length - 20} more files`
        : ''
    const commitMessage = `[${agentName}] ${summary}\n\nChanged files:\n${fileList}${overflow}`

    // Commit with agent as author
    await gitExec(
      [
        'commit',
        '-m',
        commitMessage,
        '--author',
        `${agentName} <${agentName}@octopal.local>`,
      ],
      folderPath,
    )

    return { committed: true, files: stagedFiles }
  } catch (e: any) {
    // Fail silently — never interrupt the user's workflow
    return { committed: false, error: e.message }
  }
}

// ── Phase 3: History, Diff, Revert, Push ───────────────────────────────────

/** Single commit entry returned by getCommitHistory. */
export interface CommitEntry {
  hash: string
  shortHash: string
  author: string
  email: string
  date: string      // ISO 8601
  message: string   // first line
  body: string      // remaining lines
}

/** File-level diff entry returned by getCommitDiff. */
export interface DiffEntry {
  file: string
  status: string    // 'A' | 'M' | 'D' | 'R' etc.
  additions: number
  deletions: number
  patch: string     // unified diff content
}

/**
 * Get paginated commit history for the repo.
 *
 * Returns commits newest-first. Author field is used to map agent names.
 */
export async function getCommitHistory(
  folderPath: string,
  page = 1,
  perPage = 30,
): Promise<{ commits: CommitEntry[]; total: number }> {
  if (!(await isGitRepo(folderPath))) return { commits: [], total: 0 }
  if (!(await hasCommits(folderPath))) return { commits: [], total: 0 }

  // Get total commit count
  const countOutput = await gitExec(['rev-list', '--count', 'HEAD'], folderPath)
  const total = parseInt(countOutput.trim(), 10) || 0

  // Get commits for current page
  const skip = (page - 1) * perPage
  const SEP = '---OCTOPAL_SEP---'
  const format = [
    '%H',   // full hash
    '%h',   // short hash
    '%an',  // author name
    '%ae',  // author email
    '%aI',  // author date (ISO 8601)
    '%s',   // subject (first line)
    '%b',   // body (remaining lines)
  ].join(SEP)

  const logOutput = await gitExec(
    ['log', `--format=${format}`, `--skip=${skip}`, `-n`, `${perPage}`],
    folderPath,
  )

  const commits: CommitEntry[] = logOutput
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(SEP)
      return {
        hash: parts[0] || '',
        shortHash: parts[1] || '',
        author: parts[2] || '',
        email: parts[3] || '',
        date: parts[4] || '',
        message: parts[5] || '',
        body: parts[6] || '',
      }
    })

  return { commits, total }
}

/**
 * Get file-level diff for a specific commit.
 *
 * Returns the list of changed files with their unified diff patches.
 */
export async function getCommitDiff(
  folderPath: string,
  hash: string,
): Promise<DiffEntry[]> {
  if (!(await isGitRepo(folderPath))) return []

  // Get file stat (additions/deletions per file)
  const numstatOutput = await gitExec(
    ['diff-tree', '--no-commit-id', '-r', '--numstat', hash],
    folderPath,
  )

  // Get file status (A/M/D/R)
  const nameStatusOutput = await gitExec(
    ['diff-tree', '--no-commit-id', '-r', '--name-status', hash],
    folderPath,
  )

  // Build a map of file → { status, additions, deletions }
  const statMap = new Map<string, { additions: number; deletions: number }>()
  for (const line of numstatOutput.trim().split('\n').filter(Boolean)) {
    const [add, del, ...fileParts] = line.split('\t')
    const file = fileParts.join('\t') // handle filenames with tabs (rare)
    statMap.set(file, {
      additions: parseInt(add, 10) || 0,
      deletions: parseInt(del, 10) || 0,
    })
  }

  const statusMap = new Map<string, string>()
  for (const line of nameStatusOutput.trim().split('\n').filter(Boolean)) {
    const [status, ...fileParts] = line.split('\t')
    const file = fileParts[fileParts.length - 1] || fileParts[0] // renames: use new name
    statusMap.set(file, status.charAt(0)) // R100 → R
  }

  // Get unified diff patches
  let patchOutput = ''
  try {
    patchOutput = await gitExec(
      ['diff-tree', '--no-commit-id', '-r', '-p', hash],
      folderPath,
    )
  } catch {
    // diff may fail for binary files, etc.
  }

  // Parse patches into per-file chunks
  const patchMap = new Map<string, string>()
  if (patchOutput) {
    const chunks = patchOutput.split(/^diff --git /m).filter(Boolean)
    for (const chunk of chunks) {
      // First line: "a/path b/path\n..."
      const firstNewline = chunk.indexOf('\n')
      const header = chunk.slice(0, firstNewline)
      const match = header.match(/b\/(.+)$/)
      if (match) {
        patchMap.set(match[1], 'diff --git ' + chunk)
      }
    }
  }

  // Combine everything
  const entries: DiffEntry[] = []
  const allFiles = new Set([...statMap.keys(), ...statusMap.keys()])
  for (const file of allFiles) {
    entries.push({
      file,
      status: statusMap.get(file) || 'M',
      additions: statMap.get(file)?.additions ?? 0,
      deletions: statMap.get(file)?.deletions ?? 0,
      patch: patchMap.get(file) || '',
    })
  }

  return entries
}

/**
 * Revert a single commit using `git revert` (non-destructive).
 *
 * Creates a new commit that undoes the target commit.
 * Uses --no-edit to auto-generate the revert message.
 */
export async function revertCommit(
  folderPath: string,
  hash: string,
): Promise<{ reverted: boolean; conflict: boolean; error?: string }> {
  try {
    if (!(await isGitRepo(folderPath))) {
      return { reverted: false, conflict: false, error: 'Not a git repo' }
    }

    await gitExec(['revert', '--no-edit', hash], folderPath)
    return { reverted: true, conflict: false }
  } catch (e: any) {
    const msg = e.message || ''
    // Check for conflict
    if (msg.includes('conflict') || msg.includes('CONFLICT')) {
      try {
        await gitExec(['revert', '--abort'], folderPath)
      } catch {
        // abort may fail
      }
      return { reverted: false, conflict: true, error: msg }
    }
    return { reverted: false, conflict: false, error: msg }
  }
}

/**
 * Revert a range of commits (from newest to oldest, inclusive).
 *
 * Reverts each commit individually in reverse chronological order
 * to maintain history integrity. Stops on first conflict.
 *
 * @param fromHash  The newest commit to revert (start)
 * @param toHash    The oldest commit to revert (end, inclusive)
 */
export async function revertRange(
  folderPath: string,
  fromHash: string,
  toHash: string,
): Promise<{ reverted: number; total: number; conflict: boolean; conflictAt?: string; error?: string }> {
  try {
    if (!(await isGitRepo(folderPath))) {
      return { reverted: 0, total: 0, conflict: false, error: 'Not a git repo' }
    }

    // Get the list of commits in the range (newest first)
    const logOutput = await gitExec(
      ['log', '--format=%H', `${toHash}~1..${fromHash}`],
      folderPath,
    )
    const hashes = logOutput.trim().split('\n').filter(Boolean)
    const total = hashes.length

    if (total === 0) {
      // Fallback: try inclusive range with toHash itself
      const logOutput2 = await gitExec(
        ['log', '--format=%H', `${toHash}^..${fromHash}`],
        folderPath,
      )
      const hashes2 = logOutput2.trim().split('\n').filter(Boolean)
      if (hashes2.length === 0) {
        return { reverted: 0, total: 0, conflict: false, error: 'No commits in range' }
      }
      // Revert each commit in order (newest first)
      let reverted = 0
      for (const h of hashes2) {
        const result = await revertCommit(folderPath, h)
        if (result.conflict) {
          return { reverted, total: hashes2.length, conflict: true, conflictAt: h }
        }
        if (!result.reverted) {
          return { reverted, total: hashes2.length, conflict: false, error: result.error }
        }
        reverted++
      }
      return { reverted, total: hashes2.length, conflict: false }
    }

    // Revert each commit in order (newest first)
    let reverted = 0
    for (const h of hashes) {
      const result = await revertCommit(folderPath, h)
      if (result.conflict) {
        return { reverted, total, conflict: true, conflictAt: h }
      }
      if (!result.reverted) {
        return { reverted, total, conflict: false, error: result.error }
      }
      reverted++
    }

    return { reverted, total, conflict: false }
  } catch (e: any) {
    return { reverted: 0, total: 0, conflict: false, error: e.message }
  }
}

/**
 * Check if a remote named 'origin' exists.
 */
export async function hasRemote(folderPath: string): Promise<boolean> {
  try {
    const output = await gitExec(['remote'], folderPath)
    return output.trim().split('\n').some((r) => r.trim() === 'origin')
  } catch {
    return false
  }
}

/**
 * Push current branch to origin.
 *
 * Fails silently if no remote or push rejected — never blocks the user.
 */
export async function pushToRemote(
  folderPath: string,
): Promise<{ pushed: boolean; error?: string }> {
  try {
    if (!(await isGitRepo(folderPath))) {
      return { pushed: false, error: 'Not a git repo' }
    }
    if (!(await hasRemote(folderPath))) {
      return { pushed: false, error: 'No remote origin configured' }
    }

    await gitExec(['push', 'origin', 'HEAD'], folderPath)
    return { pushed: true }
  } catch (e: any) {
    return { pushed: false, error: e.message }
  }
}

/**
 * Discard an agent branch completely (for interrupt rollback).
 *
 * Used when an agent is interrupted mid-work: checks out the base branch
 * and force-deletes the agent branch, discarding all uncommitted and
 * committed changes on it.
 */
export async function discardAgentBranch(
  folderPath: string,
  agentName: string,
  baseBranch: string,
): Promise<{ discarded: boolean; error?: string }> {
  const agentBranch = `agent/${agentName}`
  try {
    // First, discard any uncommitted changes on the agent branch
    try {
      await gitExec(['checkout', '--', '.'], folderPath)
    } catch {
      // May fail if nothing to discard
    }
    try {
      await gitExec(['clean', '-fd'], folderPath)
    } catch {
      // May fail if nothing to clean
    }

    // Switch to base branch
    await gitExec(['checkout', baseBranch], folderPath)

    // Force-delete the agent branch (uppercase -D = force)
    await gitExec(['branch', '-D', agentBranch], folderPath)

    return { discarded: true }
  } catch (e: any) {
    // Try to at least get back to base branch
    try {
      await gitExec(['checkout', baseBranch], folderPath)
    } catch {
      // Last resort
    }
    return { discarded: false, error: e.message }
  }
}
