# AI Contributor Security & Repository Governance Plan

A complete architecture, security policy, and CI enforcement plan for safely onboarding an external AI agent to perform full-feature development and refactoring without exposing the repository to accidental overwrites or unvetted code.

### User Review & Critical Decisions

> [!IMPORTANT]
> Giving an AI direct write/push access to `main` without automated CI or review carries severe risks: broken builds, accidental regressions, force-pushes, or secrets leakage. Adopting a **Pull Request (PR) workflow with automated CI gates** eliminates these risks while allowing the AI to autonomously build features.

- **Confirmed Decision 1 (Access Model)**: PR-only submission model. The external AI will operate via dedicated feature branches (or a fork) and submit Pull Requests, requiring human review before merging.
- **Confirmed Decision 2 (AI Scope)**: Full feature development and refactoring. Because the AI touches core architecture, strict automated testing and lint validation are mandatory prior to review.
- **Confirmed Decision 3 (Safeguard Status)**: No existing branch protections or CI pipelines. We will create a standardized GitHub Actions CI workflow (`lint`, `typecheck`, `test`, `build`) and establish branch protection rules for `main`.

---

### 1. Overview & Core Concept

- **What It Does**: Establishes a zero-trust, automated contribution pipeline for external AI agents. The AI creates isolated branches and PRs, GitHub Actions automatically executes validation tests, and human maintainers review and approve clean PRs with full diff transparency.
- **Target Audience / Persona**: Repository owners and human lead engineers collaborating with external AI coding assistants (such as Claude Code, GitHub Copilot Workspace, Cursor, or custom API agents).
- **Key Value**: Unlocks rapid, autonomous AI-assisted development and large-scale refactoring while ensuring 100% build stability, code quality, and branch safety.

---

### 2. Workflow & Operational Lifecycle

```
┌─────────────────┐      1. Git Branch      ┌─────────────────────────┐
│                 │ ──────────────────────> │  Feature Branch         │
│   External AI   │                         │  (e.g., ai/feature-xyz) │
│   Agent         │ ─── 2. Open PR ────┐    └────────────┬────────────┘
│                 │                    │                 │
└─────────────────┘                    ▼                 │
                         ┌───────────────────────────┐   │
                         │    GitHub Pull Request    │ ◄─┘
                         └─────────────┬─────────────┘
                                       │
                                       ▼ 3. Trigger Webhook
                         ┌───────────────────────────┐
                         │   GitHub Actions CI Job   │
                         │  • ESLint & Code Standards│
                         │  • TypeScript Typecheck   │
                         │  • Unit & Math Tests      │
                         │  • Production Build Check │
                         └─────────────┬─────────────┘
                                       │
                   ┌───────────────────┴───────────────────┐
                   ▼ (Fails)                               ▼ (Passes)
     ┌───────────────────────────┐           ┌───────────────────────────┐
     │  CI Blocks Merge          │           │  CI Green Checkmark       │
     │  AI Iterates on Branch    │           │  Human Maintainer Review  │
     └───────────────────────────┘           └─────────────┬─────────────┘
                                                           │
                                                           ▼ 4. Approve & Squash
                                             ┌───────────────────────────┐
                                             │    Protected `main`       │
                                             │    (Production Branch)    │
                                             └───────────────────────────┘
```

#### Step-by-Step Flow:
1. **Branch Isolation**: The AI creates a scoped branch (e.g., `ai/feature-name` or `refactor/subsystem`) with no ability to push directly to `main`.
2. **Automated Continuous Integration**: On every PR open or push, GitHub Actions automatically spins up an environment to test compilation, lint rules, and test suites.
3. **Merge Blocking & Feedback**: If tests or type-checks fail, the PR is automatically blocked from merging. The AI can inspect the CI logs to self-heal and push fixes.
4. **Human Review & Merge**: Once all CI checks are green, repository owners review the clean diff, request adjustments, and perform a squash-and-merge.

---

### 3. Key Decisions & Security Trade-Offs

#### Decision 1: Dedicated Scoped Account vs. Shared Personal Token
- *Chosen Approach*: Configure the AI with a dedicated GitHub Bot account or a Fine-Grained Personal Access Token (PAT) scoped strictly to `contents: write` (for branches) and `pull_requests: write`.
- *Why*: Prevents the AI from modifying repository settings, deleting branches, changing secrets, or pushing to bypass rules.
- *Alternatives Considered*: Giving the AI the repository owner's admin token (Rejected: dangerous, irreversible credential exposure).

#### Decision 2: Enforcing Branch Protection on `main`
- *Chosen Approach*: Enable GitHub Branch Protection on `main`:
  - Require pull request before merging.
  - Require at least 1 human approval.
  - Require status checks to pass (`ci / test`, `ci / lint`, `ci / build`).
  - Disallow force pushes and branch deletions.
- *Why*: Eliminates accidental `git push --force` or premature untested pushes from breaking production.

#### Decision 3: Automated CI Pre-Merge Verification
- *Chosen Approach*: Implement `.github/workflows/ci.yml` verifying `npm run lint`, `npm run build`, and unit tests (`node --test`).
- *Why*: AI refactorings frequently introduce subtle type mismatches or syntax errors; automated checks catch them before humans spend review time.

---

### 4. Technical Architecture & Implementation Blueprint

#### Component Diagram

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Repository Security Matrix                      │
├─────────────────────────┬──────────────────────┬───────────────────────┤
│ Layer                   │ Configuration        │ Policy / Protection   │
├─────────────────────────┼──────────────────────┼───────────────────────┤
│ Identity & Auth         │ Fine-Grained PAT     │ Scoped to single repo │
│                         │ or GitHub App        │ No admin permissions  │
├─────────────────────────┼──────────────────────┼───────────────────────┤
│ Branch Defense          │ GitHub Ruleset /     │ PR required           │
│                         │ Branch Protection    │ 1 Approval required   │
│                         │                      │ Strict status checks  │
├─────────────────────────┼──────────────────────┼───────────────────────┤
│ Automated Quality Gate  │ GitHub Actions CI    │ Lint + Typecheck +    │
│                         │                      │ Unit Tests + Build    │
├─────────────────────────┼──────────────────────┼───────────────────────┤
│ Audit & Traceability    │ Commit Signatures /  │ Clear PR attribution  │
│                         │ PR Templates         │ Detailed change logs  │
└─────────────────────────┴──────────────────────┴───────────────────────┘
```

#### Planned Deliverables:

1. **GitHub Actions CI Workflow (`.github/workflows/ci.yml`)**:
   - Triggers on `pull_request` targeting `main` and `push` to `main`.
   - Runs `npm ci`, `npm run lint`, `npx tsc --noEmit`, `node --test lib/game-math.test.ts`, and `npm run build`.

2. **Pull Request Template (`.github/pull_request_template.md`)**:
   - Standardized template enforcing clear feature descriptions, testing steps, and checklist for AI-generated contributions.

3. **Branch Protection Setup Guide**:
   - Clear steps for configuring GitHub repository settings to enforce approvals and status checks.
