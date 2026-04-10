import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import {
  resolveGitBinary,
  isGitAvailable,
  isGitRepo,
  ensureRepo,
  ensureGitignore,
  takeSnapshot,
  autoCommit,
  extractCommitSummary,
  getCurrentBranch,
  createAgentBranch,
  mergeAgentBranch,
  cleanupAgentBranch,
  getCommitHistory,
  getCommitDiff,
  revertCommit,
  revertRange,
  pushToRemote,
  hasRemote,
  discardAgentBranch,
} from './git-service'

// ═══════════════════════════════════════════════════════════════════════════
// Test helpers
// ═══════════════════════════════════════════════════════════════════════════

let tmpDir: string

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'octopal-git-test-'))
}

function cleanTmpDir(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {}
}

function gitInDir(args: string[], cwd: string): string {
  const gitPath = resolveGitBinary()
  return execFileSync(gitPath, args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim()
}

beforeEach(() => {
  tmpDir = createTmpDir()
})

afterEach(() => {
  cleanTmpDir(tmpDir)
})

// ═══════════════════════════════════════════════════════════════════════════
// 1. GIT BINARY RESOLUTION
// ═══════════════════════════════════════════════════════════════════════════

describe('resolveGitBinary', () => {
  it('returns a non-empty path', () => {
    const gitPath = resolveGitBinary()
    expect(gitPath).toBeTruthy()
    expect(typeof gitPath).toBe('string')
  })

  it('returns cached path on subsequent calls', () => {
    const first = resolveGitBinary()
    const second = resolveGitBinary()
    expect(first).toBe(second)
  })
})

describe('isGitAvailable', () => {
  it('returns true when Git is available', () => {
    expect(isGitAvailable()).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. REPOSITORY DETECTION & INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════

describe('isGitRepo', () => {
  it('returns false for a plain directory', async () => {
    expect(await isGitRepo(tmpDir)).toBe(false)
  })

  it('returns true after git init', async () => {
    gitInDir(['init'], tmpDir)
    expect(await isGitRepo(tmpDir)).toBe(true)
  })
})

describe('ensureRepo', () => {
  it('initializes a new repo in a plain directory', async () => {
    await ensureRepo(tmpDir)
    expect(await isGitRepo(tmpDir)).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, '.git'))).toBe(true)
  })

  it('does not re-initialize an existing repo', async () => {
    gitInDir(['init'], tmpDir)
    // Create a commit so we can verify it survives ensureRepo
    fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'hello')
    gitInDir(['add', '.'], tmpDir)
    gitInDir(['commit', '-m', 'initial', '--author', 'Test <test@test.com>'], tmpDir)

    const logBefore = gitInDir(['log', '--oneline'], tmpDir)
    await ensureRepo(tmpDir) // Should be a no-op
    const logAfter = gitInDir(['log', '--oneline'], tmpDir)

    expect(logAfter).toBe(logBefore)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. GITIGNORE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

describe('ensureGitignore', () => {
  it('creates .gitignore with defaults in a bare directory', () => {
    ensureGitignore(tmpDir)
    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8')
    expect(content).toContain('node_modules/')
    expect(content).toContain('.env')
    expect(content).toContain('.DS_Store')
    expect(content).toContain('*.log')
  })

  it('does not overwrite existing .gitignore', () => {
    const customContent = '*.custom\nmy-stuff/'
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), customContent)

    ensureGitignore(tmpDir) // Should be a no-op

    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8')
    expect(content).toBe(customContent)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. SNAPSHOT & CHANGE TRACKING
// ═══════════════════════════════════════════════════════════════════════════

describe('takeSnapshot', () => {
  it('returns empty set for non-git directory', async () => {
    const snap = await takeSnapshot(tmpDir)
    expect(snap.size).toBe(0)
  })

  it('captures dirty files in a git repo', async () => {
    gitInDir(['init'], tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'dirty.txt'), 'modified')
    gitInDir(['add', 'dirty.txt'], tmpDir)
    gitInDir(['commit', '-m', 'init', '--author', 'Test <test@test.com>'], tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'dirty.txt'), 'changed')

    const snap = await takeSnapshot(tmpDir)
    expect(snap.size).toBeGreaterThan(0)
  })

  it('captures untracked files', async () => {
    gitInDir(['init'], tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'new-file.txt'), 'hello')

    const snap = await takeSnapshot(tmpDir)
    expect(snap.size).toBeGreaterThan(0)
    // Should contain the untracked file marker
    const hasNewFile = [...snap].some((line) => line.includes('new-file.txt'))
    expect(hasNewFile).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. COMMIT SUMMARY EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════

describe('extractCommitSummary', () => {
  it('extracts first sentence from plain text', () => {
    const summary = extractCommitSummary('Added the new button component. It works great.')
    expect(summary).toBe('Added the new button component')
  })

  it('strips markdown headings', () => {
    const summary = extractCommitSummary('## Implementation Complete\nDone.')
    expect(summary).toBe('Implementation Complete')
  })

  it('strips bold markdown', () => {
    const summary = extractCommitSummary('**Fixed** the bug in renderer. It was tricky.')
    expect(summary).toBe('Fixed the bug in renderer')
  })

  it('truncates to 72 characters', () => {
    const long = 'A'.repeat(100)
    const summary = extractCommitSummary(long)
    expect(summary.length).toBeLessThanOrEqual(72)
  })

  it('returns "Auto-save" for empty text', () => {
    expect(extractCommitSummary('')).toBe('Auto-save')
  })

  it('returns "Auto-save" for interrupted output', () => {
    expect(extractCommitSummary('[interrupted]')).toBe('Auto-save')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. AUTO-COMMIT (Integration)
// ═══════════════════════════════════════════════════════════════════════════

describe('autoCommit', () => {
  it('commits new files created after snapshot', async () => {
    await ensureRepo(tmpDir)
    ensureGitignore(tmpDir)
    // Initial commit so the repo is non-empty
    gitInDir(['add', '.'], tmpDir)
    gitInDir(['commit', '-m', 'init', '--author', 'Test <test@test.com>'], tmpDir)

    // Take snapshot (clean state)
    const snap = await takeSnapshot(tmpDir)

    // Simulate agent creating a file
    fs.writeFileSync(path.join(tmpDir, 'agent-output.ts'), 'export const x = 1')

    const result = await autoCommit(tmpDir, 'developer', 'Created output file', snap)
    expect(result.committed).toBe(true)
    expect(result.files).toContain('agent-output.ts')

    // Verify the commit exists
    const log = gitInDir(['log', '--oneline', '-1'], tmpDir)
    expect(log).toContain('[developer]')
    expect(log).toContain('Created output file')
  })

  it('does not commit if nothing changed', async () => {
    await ensureRepo(tmpDir)
    ensureGitignore(tmpDir)
    gitInDir(['add', '.'], tmpDir)
    gitInDir(['commit', '-m', 'init', '--author', 'Test <test@test.com>'], tmpDir)

    const snap = await takeSnapshot(tmpDir)
    // No changes made
    const result = await autoCommit(tmpDir, 'developer', 'Nothing happened', snap)
    expect(result.committed).toBe(false)
  })

  it('only commits files changed after snapshot (pre-existing dirty files safe)', async () => {
    await ensureRepo(tmpDir)
    ensureGitignore(tmpDir)

    // Create and commit initial file
    fs.writeFileSync(path.join(tmpDir, 'tracked.txt'), 'original')
    gitInDir(['add', '.'], tmpDir)
    gitInDir(['commit', '-m', 'init', '--author', 'Test <test@test.com>'], tmpDir)

    // Dirty an existing file (user's uncommitted changes)
    fs.writeFileSync(path.join(tmpDir, 'tracked.txt'), 'user modified')

    // Take snapshot WITH the dirty state
    const snap = await takeSnapshot(tmpDir)

    // Agent creates a new file
    fs.writeFileSync(path.join(tmpDir, 'agent-new.ts'), 'agent code')

    const result = await autoCommit(tmpDir, 'designer', 'Added component', snap)
    expect(result.committed).toBe(true)
    expect(result.files).toContain('agent-new.ts')
    // Pre-existing dirty file should NOT be in the commit
    expect(result.files).not.toContain('tracked.txt')

    // Verify tracked.txt still has user's uncommitted change
    const content = fs.readFileSync(path.join(tmpDir, 'tracked.txt'), 'utf-8')
    expect(content).toBe('user modified')
  })

  it('sets correct author on commit', async () => {
    await ensureRepo(tmpDir)
    ensureGitignore(tmpDir)
    gitInDir(['add', '.'], tmpDir)
    gitInDir(['commit', '-m', 'init', '--author', 'Test <test@test.com>'], tmpDir)

    const snap = await takeSnapshot(tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'agent-file.ts'), 'code here')

    await autoCommit(tmpDir, 'planner', 'Planned feature', snap)

    const author = gitInDir(['log', '-1', '--format=%an <%ae>'], tmpDir)
    expect(author).toBe('planner <planner@octopal.local>')
  })

  it('initializes repo if none exists (lazy init)', async () => {
    // Don't pre-init — autoCommit should do it
    const snap = new Set<string>()
    fs.writeFileSync(path.join(tmpDir, 'brand-new.txt'), 'content')

    const result = await autoCommit(tmpDir, 'developer', 'First change', snap)
    expect(result.committed).toBe(true)
    expect(await isGitRepo(tmpDir)).toBe(true)
  })

  it('includes changed files list in commit message', async () => {
    await ensureRepo(tmpDir)
    ensureGitignore(tmpDir)
    gitInDir(['add', '.'], tmpDir)
    gitInDir(['commit', '-m', 'init', '--author', 'Test <test@test.com>'], tmpDir)

    const snap = await takeSnapshot(tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'alpha.ts'), 'a')
    fs.writeFileSync(path.join(tmpDir, 'beta.ts'), 'b')

    await autoCommit(tmpDir, 'developer', 'Multi-file change', snap)

    const message = gitInDir(['log', '-1', '--format=%B'], tmpDir)
    expect(message).toContain('Changed files:')
    expect(message).toContain('alpha.ts')
    expect(message).toContain('beta.ts')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 7. BRANCH MANAGEMENT (Phase 2)
// ═══════════════════════════════════════════════════════════════════════════

describe('getCurrentBranch', () => {
  it('returns "main" after ensureRepo initializes', async () => {
    await ensureRepo(tmpDir)
    // Need at least one commit for branch to exist
    fs.writeFileSync(path.join(tmpDir, 'init.txt'), 'init')
    gitInDir(['add', '.'], tmpDir)
    gitInDir(['commit', '-m', 'init', '--author', 'Test <test@test.com>'], tmpDir)

    const branch = await getCurrentBranch(tmpDir)
    expect(branch).toBe('main')
  })

  it('returns correct branch name after checkout', async () => {
    gitInDir(['init'], tmpDir)
    gitInDir(['checkout', '-b', 'feature'], tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'f.txt'), 'f')
    gitInDir(['add', '.'], tmpDir)
    gitInDir(['commit', '-m', 'feat', '--author', 'Test <test@test.com>'], tmpDir)

    const branch = await getCurrentBranch(tmpDir)
    expect(branch).toBe('feature')
  })
})

describe('createAgentBranch', () => {
  it('creates agent branch from current branch', async () => {
    await ensureRepo(tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'init.txt'), 'init')
    gitInDir(['add', '.'], tmpDir)
    gitInDir(['commit', '-m', 'init', '--author', 'Test <test@test.com>'], tmpDir)

    const result = await createAgentBranch(tmpDir, 'developer')
    expect(result.created).toBe(true)
    expect(result.baseBranch).toBe('main')
    expect(result.agentBranch).toBe('agent/developer')

    // Verify we're on the agent branch
    const branch = await getCurrentBranch(tmpDir)
    expect(branch).toBe('agent/developer')
  })

  it('skips branching for empty repo (no commits)', async () => {
    await ensureRepo(tmpDir)

    const result = await createAgentBranch(tmpDir, 'designer')
    expect(result.created).toBe(false)
  })

  it('uses current branch as base (not hardcoded main)', async () => {
    gitInDir(['init'], tmpDir)
    gitInDir(['checkout', '-b', 'develop'], tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'f.txt'), 'f')
    gitInDir(['add', '.'], tmpDir)
    gitInDir(['commit', '-m', 'init', '--author', 'Test <test@test.com>'], tmpDir)

    const result = await createAgentBranch(tmpDir, 'planner')
    expect(result.created).toBe(true)
    expect(result.baseBranch).toBe('develop')
    expect(result.agentBranch).toBe('agent/planner')
  })

  it('resets existing agent branch with -B flag', async () => {
    await ensureRepo(tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'init.txt'), 'init')
    gitInDir(['add', '.'], tmpDir)
    gitInDir(['commit', '-m', 'init', '--author', 'Test <test@test.com>'], tmpDir)

    // Create agent branch first time
    await createAgentBranch(tmpDir, 'developer')
    fs.writeFileSync(path.join(tmpDir, 'agent-work.txt'), 'work')
    gitInDir(['add', '.'], tmpDir)
    gitInDir(['commit', '-m', 'agent work', '--author', 'Dev <dev@test.com>'], tmpDir)

    // Go back to main
    gitInDir(['checkout', 'main'], tmpDir)

    // Create agent branch again — should reset to current HEAD
    const result = await createAgentBranch(tmpDir, 'developer')
    expect(result.created).toBe(true)

    // The agent work commit should be gone (branch was reset)
    const log = gitInDir(['log', '--oneline'], tmpDir)
    expect(log).not.toContain('agent work')
  })
})

describe('mergeAgentBranch', () => {
  it('fast-forward merges agent branch into base', async () => {
    await ensureRepo(tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'init.txt'), 'init')
    gitInDir(['add', '.'], tmpDir)
    gitInDir(['commit', '-m', 'init', '--author', 'Test <test@test.com>'], tmpDir)

    // Create agent branch and make a commit
    const branchResult = await createAgentBranch(tmpDir, 'developer')
    fs.writeFileSync(path.join(tmpDir, 'feature.ts'), 'export const x = 1')
    gitInDir(['add', '.'], tmpDir)
    gitInDir(['commit', '-m', 'agent commit', '--author', 'Dev <dev@test.com>'], tmpDir)

    // Merge back
    const mergeResult = await mergeAgentBranch(tmpDir, 'developer', branchResult.baseBranch)
    expect(mergeResult.merged).toBe(true)
    expect(mergeResult.conflict).toBe(false)

    // Verify we're back on main
    const branch = await getCurrentBranch(tmpDir)
    expect(branch).toBe('main')

    // Verify the agent commit is now on main
    const log = gitInDir(['log', '--oneline'], tmpDir)
    expect(log).toContain('agent commit')
  })

  it('detects conflict when base branch moved forward', async () => {
    await ensureRepo(tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'shared.txt'), 'original')
    gitInDir(['add', '.'], tmpDir)
    gitInDir(['commit', '-m', 'init', '--author', 'Test <test@test.com>'], tmpDir)

    // Create agent branch
    const branchResult = await createAgentBranch(tmpDir, 'developer')

    // Agent makes a commit
    fs.writeFileSync(path.join(tmpDir, 'shared.txt'), 'agent version')
    gitInDir(['add', '.'], tmpDir)
    gitInDir(['commit', '-m', 'agent edit', '--author', 'Dev <dev@test.com>'], tmpDir)

    // Meanwhile, base branch moved forward (simulate concurrent change)
    gitInDir(['checkout', branchResult.baseBranch], tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'shared.txt'), 'user version')
    gitInDir(['add', '.'], tmpDir)
    gitInDir(['commit', '-m', 'user edit', '--author', 'User <user@test.com>'], tmpDir)

    // Switch back to agent branch to simulate the merge happening from agent branch context
    gitInDir(['checkout', 'agent/developer'], tmpDir)

    // Try to merge — should fail (not ff-only)
    const mergeResult = await mergeAgentBranch(tmpDir, 'developer', branchResult.baseBranch)
    expect(mergeResult.merged).toBe(false)
    expect(mergeResult.conflict).toBe(true)
    expect(mergeResult.agentBranch).toBe('agent/developer')

    // Verify we're back on base branch (recovered)
    const branch = await getCurrentBranch(tmpDir)
    expect(branch).toBe('main')
  })

  it('handles merge when no new commits on agent branch', async () => {
    await ensureRepo(tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'init.txt'), 'init')
    gitInDir(['add', '.'], tmpDir)
    gitInDir(['commit', '-m', 'init', '--author', 'Test <test@test.com>'], tmpDir)

    // Create agent branch but don't make any commits
    const branchResult = await createAgentBranch(tmpDir, 'designer')

    // Merge back — should succeed (no-op, same commit)
    const mergeResult = await mergeAgentBranch(tmpDir, 'designer', branchResult.baseBranch)
    expect(mergeResult.merged).toBe(true)
    expect(mergeResult.conflict).toBe(false)
  })
})

describe('cleanupAgentBranch', () => {
  it('deletes the agent branch after merge', async () => {
    await ensureRepo(tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'init.txt'), 'init')
    gitInDir(['add', '.'], tmpDir)
    gitInDir(['commit', '-m', 'init', '--author', 'Test <test@test.com>'], tmpDir)

    // Create agent branch, commit, merge
    await createAgentBranch(tmpDir, 'developer')
    fs.writeFileSync(path.join(tmpDir, 'work.ts'), 'code')
    gitInDir(['add', '.'], tmpDir)
    gitInDir(['commit', '-m', 'work', '--author', 'Dev <dev@test.com>'], tmpDir)
    await mergeAgentBranch(tmpDir, 'developer', 'main')

    // Now clean up
    await cleanupAgentBranch(tmpDir, 'developer')

    // Verify branch is gone
    const branches = gitInDir(['branch'], tmpDir)
    expect(branches).not.toContain('agent/developer')
  })

  it('does not throw if branch does not exist', async () => {
    await ensureRepo(tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'init.txt'), 'init')
    gitInDir(['add', '.'], tmpDir)
    gitInDir(['commit', '-m', 'init', '--author', 'Test <test@test.com>'], tmpDir)

    // Should not throw
    await expect(cleanupAgentBranch(tmpDir, 'nonexistent')).resolves.toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 8. FULL PHASE 2 INTEGRATION
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 2 Integration: branch → commit → merge → cleanup', () => {
  it('full workflow: branch, agent commit, merge, cleanup', async () => {
    await ensureRepo(tmpDir)
    ensureGitignore(tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'init.txt'), 'init')
    gitInDir(['add', '.'], tmpDir)
    gitInDir(['commit', '-m', 'init', '--author', 'Test <test@test.com>'], tmpDir)

    // Step 1: Create agent branch
    const branchResult = await createAgentBranch(tmpDir, 'developer')
    expect(branchResult.created).toBe(true)
    expect(await getCurrentBranch(tmpDir)).toBe('agent/developer')

    // Step 2: Take snapshot + simulate agent work + autoCommit
    const snap = await takeSnapshot(tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'feature.ts'), 'export function hello() {}')
    fs.writeFileSync(path.join(tmpDir, 'feature.test.ts'), 'test("hello", () => {})')

    const commitResult = await autoCommit(tmpDir, 'developer', 'Added hello feature', snap)
    expect(commitResult.committed).toBe(true)
    expect(commitResult.files).toContain('feature.ts')
    expect(commitResult.files).toContain('feature.test.ts')

    // Step 3: Merge back to main
    const mergeResult = await mergeAgentBranch(tmpDir, 'developer', branchResult.baseBranch)
    expect(mergeResult.merged).toBe(true)
    expect(await getCurrentBranch(tmpDir)).toBe('main')

    // Step 4: Clean up
    await cleanupAgentBranch(tmpDir, 'developer')
    const branches = gitInDir(['branch'], tmpDir)
    expect(branches).not.toContain('agent/developer')

    // Verify files are on main
    const log = gitInDir(['log', '--oneline'], tmpDir)
    expect(log).toContain('Added hello feature')
    expect(fs.existsSync(path.join(tmpDir, 'feature.ts'))).toBe(true)
  })

  it('preserves pre-existing dirty files through branch workflow', async () => {
    await ensureRepo(tmpDir)
    ensureGitignore(tmpDir)

    // Create tracked file
    fs.writeFileSync(path.join(tmpDir, 'user-file.txt'), 'original')
    gitInDir(['add', '.'], tmpDir)
    gitInDir(['commit', '-m', 'init', '--author', 'Test <test@test.com>'], tmpDir)

    // User makes uncommitted changes
    fs.writeFileSync(path.join(tmpDir, 'user-file.txt'), 'user modified')

    // Step 1: Create agent branch (dirty changes carry over)
    const branchResult = await createAgentBranch(tmpDir, 'designer')
    expect(branchResult.created).toBe(true)

    // Step 2: Snapshot (includes user's dirty file) + agent work
    const snap = await takeSnapshot(tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'design.css'), '.btn { color: red }')

    const commitResult = await autoCommit(tmpDir, 'designer', 'Added button styles', snap)
    expect(commitResult.committed).toBe(true)
    expect(commitResult.files).toContain('design.css')
    expect(commitResult.files).not.toContain('user-file.txt')

    // Step 3: Merge back
    const mergeResult = await mergeAgentBranch(tmpDir, 'designer', branchResult.baseBranch)
    expect(mergeResult.merged).toBe(true)

    // User's dirty file should still be dirty
    const userContent = fs.readFileSync(path.join(tmpDir, 'user-file.txt'), 'utf-8')
    expect(userContent).toBe('user modified')

    // Clean up
    await cleanupAgentBranch(tmpDir, 'designer')
  })

  it('conflict scenario: agent branch preserved, base restored', async () => {
    await ensureRepo(tmpDir)
    ensureGitignore(tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'shared.txt'), 'v1')
    gitInDir(['add', '.'], tmpDir)
    gitInDir(['commit', '-m', 'init', '--author', 'Test <test@test.com>'], tmpDir)

    // Agent starts working on a branch
    const branchResult = await createAgentBranch(tmpDir, 'developer')
    fs.writeFileSync(path.join(tmpDir, 'shared.txt'), 'agent v2')
    gitInDir(['add', '.'], tmpDir)
    gitInDir(['commit', '-m', 'agent change', '--author', 'Dev <dev@test.com>'], tmpDir)

    // Concurrent: someone commits to base directly
    gitInDir(['checkout', branchResult.baseBranch], tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'shared.txt'), 'user v2')
    gitInDir(['add', '.'], tmpDir)
    gitInDir(['commit', '-m', 'user change', '--author', 'User <user@test.com>'], tmpDir)
    gitInDir(['checkout', 'agent/developer'], tmpDir)

    // Merge fails — conflict
    const mergeResult = await mergeAgentBranch(tmpDir, 'developer', branchResult.baseBranch)
    expect(mergeResult.conflict).toBe(true)
    expect(mergeResult.merged).toBe(false)

    // Agent branch should still exist (preserved)
    const branches = gitInDir(['branch'], tmpDir)
    expect(branches).toContain('agent/developer')

    // We should be back on base branch
    expect(await getCurrentBranch(tmpDir)).toBe('main')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 9. PHASE 3: COMMIT HISTORY
// ═══════════════════════════════════════════════════════════════════════════

describe('getCommitHistory', () => {
  it('returns empty for non-repo', async () => {
    const result = await getCommitHistory(tmpDir)
    expect(result.commits).toEqual([])
    expect(result.total).toBe(0)
  })

  it('returns commit list with correct fields', async () => {
    await ensureRepo(tmpDir)
    ensureGitignore(tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'hello')
    gitInDir(['add', '.'], tmpDir)
    gitInDir(['commit', '-m', 'first commit', '--author', 'developer <developer@octopal.local>'], tmpDir)

    fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'world')
    gitInDir(['add', '.'], tmpDir)
    gitInDir(['commit', '-m', 'second commit', '--author', 'designer <designer@octopal.local>'], tmpDir)

    const result = await getCommitHistory(tmpDir)
    expect(result.total).toBe(2)
    expect(result.commits).toHaveLength(2)

    // Newest first
    expect(result.commits[0].message).toBe('second commit')
    expect(result.commits[0].author).toBe('designer')
    expect(result.commits[1].message).toBe('first commit')
    expect(result.commits[1].author).toBe('developer')

    // Fields present
    expect(result.commits[0].hash).toBeTruthy()
    expect(result.commits[0].shortHash).toBeTruthy()
    expect(result.commits[0].date).toBeTruthy()
    expect(result.commits[0].email).toBe('designer@octopal.local')
  })

  it('supports pagination', async () => {
    await ensureRepo(tmpDir)
    ensureGitignore(tmpDir)
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(tmpDir, `file${i}.txt`), `content ${i}`)
      gitInDir(['add', '.'], tmpDir)
      gitInDir(['commit', '-m', `commit ${i}`, '--author', 'dev <dev@test.com>'], tmpDir)
    }

    const page1 = await getCommitHistory(tmpDir, 1, 2)
    expect(page1.total).toBe(5)
    expect(page1.commits).toHaveLength(2)
    expect(page1.commits[0].message).toBe('commit 4')

    const page2 = await getCommitHistory(tmpDir, 2, 2)
    expect(page2.commits).toHaveLength(2)
    expect(page2.commits[0].message).toBe('commit 2')

    const page3 = await getCommitHistory(tmpDir, 3, 2)
    expect(page3.commits).toHaveLength(1)
    expect(page3.commits[0].message).toBe('commit 0')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 10. PHASE 3: COMMIT DIFF
// ═══════════════════════════════════════════════════════════════════════════

describe('getCommitDiff', () => {
  it('returns empty for non-repo', async () => {
    const result = await getCommitDiff(tmpDir, 'abc123')
    expect(result).toEqual([])
  })

  it('returns file-level diff with status and stats', async () => {
    await ensureRepo(tmpDir)
    ensureGitignore(tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'readme.txt'), 'initial')
    gitInDir(['add', '.'], tmpDir)
    gitInDir(['commit', '-m', 'init', '--author', 'dev <dev@test.com>'], tmpDir)

    // Modify + add new file
    fs.writeFileSync(path.join(tmpDir, 'readme.txt'), 'updated\nline2')
    fs.writeFileSync(path.join(tmpDir, 'new.txt'), 'new file')
    gitInDir(['add', '.'], tmpDir)
    gitInDir(['commit', '-m', 'changes', '--author', 'dev <dev@test.com>'], tmpDir)

    const hash = gitInDir(['rev-parse', 'HEAD'], tmpDir)
    const entries = await getCommitDiff(tmpDir, hash)
    expect(entries.length).toBeGreaterThanOrEqual(1)

    const newFile = entries.find((e) => e.file === 'new.txt')
    expect(newFile).toBeDefined()
    expect(newFile!.status).toBe('A')
    expect(newFile!.additions).toBeGreaterThan(0)

    const modFile = entries.find((e) => e.file === 'readme.txt')
    expect(modFile).toBeDefined()
    expect(modFile!.status).toBe('M')
    expect(modFile!.patch).toContain('updated')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 11. PHASE 3: REVERT
// ═══════════════════════════════════════════════════════════════════════════

describe('revertCommit', () => {
  it('reverts a single commit non-destructively', async () => {
    await ensureRepo(tmpDir)
    ensureGitignore(tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'keep.txt'), 'keep this')
    gitInDir(['add', '.'], tmpDir)
    gitInDir(['commit', '-m', 'base', '--author', 'dev <dev@test.com>'], tmpDir)

    fs.writeFileSync(path.join(tmpDir, 'unwanted.txt'), 'bad change')
    gitInDir(['add', '.'], tmpDir)
    gitInDir(['commit', '-m', 'bad commit', '--author', 'dev <dev@test.com>'], tmpDir)

    const hash = gitInDir(['rev-parse', 'HEAD'], tmpDir)
    const result = await revertCommit(tmpDir, hash)
    expect(result.reverted).toBe(true)
    expect(result.conflict).toBe(false)

    // File should be removed by the revert
    expect(fs.existsSync(path.join(tmpDir, 'unwanted.txt'))).toBe(false)
    // History should have 3 commits (base + bad + revert)
    const log = gitInDir(['log', '--oneline'], tmpDir)
    expect(log.split('\n')).toHaveLength(3)
  })

  it('detects conflict and aborts cleanly', async () => {
    await ensureRepo(tmpDir)
    ensureGitignore(tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'v1')
    gitInDir(['add', '.'], tmpDir)
    gitInDir(['commit', '-m', 'v1', '--author', 'dev <dev@test.com>'], tmpDir)

    const hash = gitInDir(['rev-parse', 'HEAD'], tmpDir)

    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'v2 different')
    gitInDir(['add', '.'], tmpDir)
    gitInDir(['commit', '-m', 'v2', '--author', 'dev <dev@test.com>'], tmpDir)

    // Reverting v1 (which set content to 'v1') should conflict with v2
    const result = await revertCommit(tmpDir, hash)
    expect(result.conflict).toBe(true)
    expect(result.reverted).toBe(false)
  })

  it('returns error for non-repo', async () => {
    const result = await revertCommit(tmpDir, 'abc')
    expect(result.reverted).toBe(false)
    expect(result.error).toBe('Not a git repo')
  })
})

describe('revertRange', () => {
  it('reverts multiple commits in sequence', async () => {
    await ensureRepo(tmpDir)
    ensureGitignore(tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'base.txt'), 'base')
    gitInDir(['add', '.'], tmpDir)
    gitInDir(['commit', '-m', 'base', '--author', 'dev <dev@test.com>'], tmpDir)

    // 3 sequential commits adding separate files
    const hashes: string[] = []
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(tmpDir, `file${i}.txt`), `content ${i}`)
      gitInDir(['add', '.'], tmpDir)
      gitInDir(['commit', '-m', `add file${i}`, '--author', 'dev <dev@test.com>'], tmpDir)
      hashes.push(gitInDir(['rev-parse', 'HEAD'], tmpDir))
    }

    // Revert all 3 (newest to oldest)
    const result = await revertRange(tmpDir, hashes[2], hashes[0])
    expect(result.conflict).toBe(false)
    expect(result.reverted).toBe(3)
    expect(result.total).toBe(3)

    // All 3 files should be gone
    for (let i = 0; i < 3; i++) {
      expect(fs.existsSync(path.join(tmpDir, `file${i}.txt`))).toBe(false)
    }
    // Base file should still exist
    expect(fs.existsSync(path.join(tmpDir, 'base.txt'))).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 12. PHASE 3: REMOTE
// ═══════════════════════════════════════════════════════════════════════════

describe('hasRemote / pushToRemote', () => {
  it('returns false when no remote configured', async () => {
    await ensureRepo(tmpDir)
    expect(await hasRemote(tmpDir)).toBe(false)
  })

  it('returns error when no remote for push', async () => {
    await ensureRepo(tmpDir)
    const result = await pushToRemote(tmpDir)
    expect(result.pushed).toBe(false)
    expect(result.error).toContain('No remote')
  })

  it('returns false for non-repo', async () => {
    expect(await hasRemote(tmpDir)).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 13. PHASE 3: DISCARD AGENT BRANCH (Interrupt Rollback)
// ═══════════════════════════════════════════════════════════════════════════

describe('discardAgentBranch', () => {
  it('discards agent branch and returns to base', async () => {
    await ensureRepo(tmpDir)
    ensureGitignore(tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'init.txt'), 'init')
    gitInDir(['add', '.'], tmpDir)
    gitInDir(['commit', '-m', 'init', '--author', 'dev <dev@test.com>'], tmpDir)

    // Create agent branch + make changes
    const branchResult = await createAgentBranch(tmpDir, 'developer')
    expect(branchResult.created).toBe(true)

    fs.writeFileSync(path.join(tmpDir, 'agent-work.txt'), 'incomplete work')
    gitInDir(['add', '.'], tmpDir)
    gitInDir(['commit', '-m', 'agent wip', '--author', 'dev <dev@test.com>'], tmpDir)

    // Discard
    const result = await discardAgentBranch(tmpDir, 'developer', branchResult.baseBranch)
    expect(result.discarded).toBe(true)

    // Should be on base branch
    expect(await getCurrentBranch(tmpDir)).toBe('main')

    // Agent branch should be gone
    const branches = gitInDir(['branch'], tmpDir)
    expect(branches).not.toContain('agent/developer')

    // Agent's committed file should not be on main
    expect(fs.existsSync(path.join(tmpDir, 'agent-work.txt'))).toBe(false)
  })

  it('discards uncommitted changes too', async () => {
    await ensureRepo(tmpDir)
    ensureGitignore(tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'init.txt'), 'init')
    gitInDir(['add', '.'], tmpDir)
    gitInDir(['commit', '-m', 'init', '--author', 'dev <dev@test.com>'], tmpDir)

    await createAgentBranch(tmpDir, 'designer')
    // Write but don't commit
    fs.writeFileSync(path.join(tmpDir, 'dirty.txt'), 'uncommitted')

    const result = await discardAgentBranch(tmpDir, 'designer', 'main')
    expect(result.discarded).toBe(true)
    expect(await getCurrentBranch(tmpDir)).toBe('main')
    expect(fs.existsSync(path.join(tmpDir, 'dirty.txt'))).toBe(false)
  })
})
